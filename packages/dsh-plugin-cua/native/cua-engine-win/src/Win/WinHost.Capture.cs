using System.Text.Json.Nodes;
using System.IO;
using System.Windows.Media;
using System.Windows.Media.Imaging;

namespace CuaEngine.Win;

/// <summary>
/// Screen capture.
/// </summary>
/// <remarks>
/// Two capture paths, because neither covers everything. A window is captured
/// with <c>PrintWindow</c> and <c>PW_RENDERFULLCONTENT</c>, which asks the
/// window to draw itself and therefore works even when another window covers it
/// — the property the tools promise. Anything else is a straight <c>BitBlt</c>
/// from the screen, which is exact and fast but can only see what is actually
/// displayed. When <c>PrintWindow</c> returns nothing (some GPU-composited and
/// protected surfaces refuse), the window falls back to the screen path rather
/// than returning a black rectangle.
/// </remarks>
public sealed partial class WinHost
{
    /// <summary>A captured rectangle: BGRA rows, top-down.</summary>
    private sealed record Surface(byte[] Pixels, int Width, int Height);

    private sealed record CaptureTarget(Native.RECT Region, IntPtr? Window, DisplayRecord? Display, bool IsWindowOrDisplay);

    /// <summary>Capture a window, a display, or a rectangle of the screen.</summary>
    public JsonObject Screenshot(Params parameters)
    {
        // Checked before the parameters, matching the macOS backend's ordering:
        // a locked workstation swaps in a different desktop, so a capture would
        // return the lock screen and read as a rendering failure rather than as
        // the session state it actually is.
        if (Native.IsSessionLocked())
        {
            throw CuaException.Failed(
                "the screen is locked, so nothing can be captured. Unlock the session and try again.");
        }

        parameters.RejectUnknown(
            "windowId", "pid", "app", "displayId", "windowTitle", "frontmost", "includeBackground",
            "x", "y", "width", "height", "format", "quality", "maxWidth", "maxHeight", "showCursor");

        var windowId = parameters.Int("windowId");
        var pid = parameters.Int("pid");
        var appQuery = parameters.String("app");
        var displayId = parameters.Int("displayId");
        var titleQuery = parameters.String("windowTitle");
        var showCursor = parameters.Bool("showCursor", false);
        _ = parameters.Bool("includeBackground", false);

        // `jpeg`/`jpg` in any case means JPEG; anything else is PNG, so an
        // unrecognised format degrades to the lossless one rather than failing.
        var requested = parameters.String("format") ?? "png";
        var format = requested.Equals("jpeg", StringComparison.OrdinalIgnoreCase)
            || requested.Equals("jpg", StringComparison.OrdinalIgnoreCase)
                ? "jpeg"
                : "png";
        var quality = parameters.Double("quality") ?? 0.8;
        if (quality is < 0.1 or > 1.0) throw CuaException.Invalid("\"quality\" must be between 0.1 and 1.0");
        var maxWidth = parameters.Int("maxWidth") ?? 1568;
        var maxHeight = parameters.Int("maxHeight") ?? 1568;
        if (maxWidth is < 64 or > 8192) throw CuaException.Invalid("\"maxWidth\" must be between 64 and 8192");
        if (maxHeight is < 64 or > 8192) throw CuaException.Invalid("\"maxHeight\" must be between 64 and 8192");

        var hasRegion = parameters.Has("x") || parameters.Has("y") || parameters.Has("width") || parameters.Has("height");
        var frontmost = parameters.Bool("frontmost", !hasRegion);

        var target = ResolveCaptureTarget(windowId, pid, appQuery, displayId, titleQuery, frontmost);
        var (region, clipped) = ApplyRegion(parameters, target);

        if (target.Display is null && !target.IsWindowOrDisplay && LargestOverlap(region) is null)
        {
            throw CuaException.NotFound(
                $"the requested region {Discovery.Describe(region)} does not overlap any display");
        }
        var display = target.Display ?? LargestOverlap(region);

        var surface = target.Window is { } window
            ? CaptureWindow(window, region, showCursor)
            : CaptureScreen(region, showCursor);

        var (image, pixelWidth, pixelHeight) = Downscale(surface, maxWidth, maxHeight);
        var (data, mimeType, byteLength) = Encode(image, format, quality);

        return new JsonObject
        {
            ["data"] = data,
            ["mimeType"] = mimeType,
            ["pixelWidth"] = pixelWidth,
            ["pixelHeight"] = pixelHeight,
            ["pointWidth"] = (double)region.Width,
            ["pointHeight"] = (double)region.Height,
            ["region"] = Discovery.Frame(region),
            ["clipped"] = clipped,
            ["scale"] = pixelWidth / (double)Math.Max(region.Width, 1),
            ["scaleY"] = pixelHeight / (double)Math.Max(region.Height, 1),
            ["byteLength"] = byteLength,
            ["app"] = FrontmostAppName(),
            ["windowId"] = target.Window?.ToInt64(),
            ["displayId"] = display?.DisplayId,
        };
    }

    // MARK: - Target resolution

    private CaptureTarget ResolveCaptureTarget(
        int? windowId, int? pid, string? appQuery, int? displayId, string? titleQuery, bool frontmost)
    {
        if (windowId is not null)
        {
            var handle = new IntPtr(windowId.Value);
            var window = Discovery.Window(handle)
                ?? throw CuaException.NotFound($"no window with id {windowId}; list windows first");
            if (window.IsMinimized)
            {
                throw CuaException.NotFound(
                    $"window {windowId} is minimized, so it has nothing to draw; restore it first "
                    + "(cua_app with action=activate) or capture the display instead");
            }
            return new CaptureTarget(window.Bounds, handle, DisplayFor(window.Bounds), IsWindowOrDisplay: true);
        }

        if (pid is not null)
        {
            var window = Discovery.FindWindow((uint)pid.Value, titleQuery, requireVisible: false)
                ?? throw CuaException.NotFound(
                    $"pid {pid} has no capturable window"
                    + (titleQuery is { Length: > 0 } ? $" matching \"{titleQuery}\"" : string.Empty));
            return new CaptureTarget(window.Bounds, window.Handle, DisplayFor(window.Bounds), IsWindowOrDisplay: true);
        }

        if (displayId is not null)
        {
            var display = Discovery.Displays().FirstOrDefault(entry => entry.DisplayId == displayId.Value)
                ?? throw CuaException.NotFound(
                    $"no display with id {displayId}; call cua_displays for the ids on this machine");
            return new CaptureTarget(display.Bounds, null, display, IsWindowOrDisplay: true);
        }

        if (appQuery is { Length: > 0 })
        {
            var match = Discovery.RunningApps()
                .Where(app => app.Name.Contains(appQuery, StringComparison.OrdinalIgnoreCase)
                    || app.AppId.Contains(appQuery, StringComparison.OrdinalIgnoreCase)
                    || app.Path.Contains(appQuery, StringComparison.OrdinalIgnoreCase))
                .FirstOrDefault(app => !app.Hidden)
                ?? throw CuaException.NotFound($"no application matches \"{appQuery}\"; call cua_apps");
            var window = Discovery.FindWindow(match.ProcessId, null, requireVisible: false)
                ?? throw CuaException.NotFound($"no capturable window for \"{appQuery}\"");
            return new CaptureTarget(window.Bounds, window.Handle, DisplayFor(window.Bounds), IsWindowOrDisplay: true);
        }

        if (frontmost)
        {
            var foreground = Native.GetForegroundWindow();
            if (foreground != IntPtr.Zero && Discovery.Window(foreground) is { } window && !window.IsMinimized)
            {
                return new CaptureTarget(window.Bounds, foreground, DisplayFor(window.Bounds), IsWindowOrDisplay: true);
            }
        }

        return new CaptureTarget(Discovery.Desktop(), null, null, IsWindowOrDisplay: false);
    }

    private static DisplayRecord? DisplayFor(Native.RECT bounds) =>
        Discovery.DisplayAt(bounds.Left + bounds.Width / 2, bounds.Top + bounds.Height / 2);

    /// <summary>Apply an explicit crop rectangle to the resolved target.</summary>
    /// <remarks>
    /// With a window or display target the rectangle refines it and must
    /// actually fall inside; without one there is nothing to refine, so the
    /// rectangle is the whole request.
    /// </remarks>
    /// <summary>
    /// The region to capture, and whether the request had to be trimmed to fit.
    /// </summary>
    /// <remarks>
    /// `clipped` is part of the wire contract because `region` is reported as the
    /// area actually captured: without the flag a caller comparing its request to
    /// the answer cannot tell an off-by-one from a rectangle that ran off the edge
    /// of the window. A partially overlapping region is clipped rather than
    /// rejected, so the flag is the only signal that it happened.
    /// </remarks>
    private static (Native.RECT Region, bool Clipped) ApplyRegion(Params parameters, CaptureTarget target)
    {
        var keys = new[] { "x", "y", "width", "height" };
        var present = keys.Where(parameters.Has).ToArray();
        if (present.Length == 0) return (target.Region, false);
        if (present.Length != 4)
        {
            throw CuaException.Invalid(
                $"a capture region needs all of x, y, width, and height; received {string.Join(", ", present)}");
        }

        var x = parameters.RequiredDouble("x");
        var y = parameters.RequiredDouble("y");
        var width = parameters.RequiredDouble("width");
        var height = parameters.RequiredDouble("height");
        if (width <= 0 || height <= 0) throw CuaException.Invalid("region width and height must be positive");

        var requested = new Native.RECT
        {
            Left = (int)Math.Round(x),
            Top = (int)Math.Round(y),
            Right = (int)Math.Round(x + width),
            Bottom = (int)Math.Round(y + height),
        };
        if (!target.IsWindowOrDisplay) return (requested, false);

        var left = Math.Max(requested.Left, target.Region.Left);
        var top = Math.Max(requested.Top, target.Region.Top);
        var right = Math.Min(requested.Right, target.Region.Right);
        var bottom = Math.Min(requested.Bottom, target.Region.Bottom);
        if (right <= left || bottom <= top)
        {
            throw CuaException.Invalid(
                $"the requested region {Discovery.Describe(requested)} lies outside the capture target "
                + Discovery.Describe(target.Region));
        }
        // A partially overlapping region is clipped rather than rejected, so a
        // request that runs off the edge of a window still returns the part
        // that exists.
        var clipped = left != requested.Left || top != requested.Top
            || right != requested.Right || bottom != requested.Bottom;
        return (new Native.RECT { Left = left, Top = top, Right = right, Bottom = bottom }, clipped);
    }

    private static DisplayRecord? LargestOverlap(Native.RECT region) =>
        Discovery.Displays()
            .Select(display => (Display: display, Area: IntersectionArea(region, display.Bounds)))
            .Where(entry => entry.Area > 0)
            .OrderByDescending(entry => entry.Area)
            .Select(entry => entry.Display)
            .FirstOrDefault();

    private static long IntersectionArea(Native.RECT a, Native.RECT b)
    {
        var width = Math.Min(a.Right, b.Right) - Math.Max(a.Left, b.Left);
        var height = Math.Min(a.Bottom, b.Bottom) - Math.Max(a.Top, b.Top);
        return width <= 0 || height <= 0 ? 0 : (long)width * height;
    }

    private static string? FrontmostAppName()
    {
        var foreground = Native.GetForegroundWindow();
        if (foreground == IntPtr.Zero) return null;
        Native.GetWindowThreadProcessId(foreground, out uint pid);
        return Discovery.ProcessName(pid, Discovery.ProcessImagePath(pid));
    }

    // MARK: - Pixels

    /// <summary>Capture a screen rectangle.</summary>
    private static Surface CaptureScreen(Native.RECT region, bool showCursor)
    {
        var width = Math.Max(region.Width, 1);
        var height = Math.Max(region.Height, 1);
        var screen = Native.GetDC(IntPtr.Zero);
        if (screen == IntPtr.Zero) throw CuaException.Failed("the screen device context could not be opened");
        var memory = Native.CreateCompatibleDC(screen);
        var bitmap = Native.CreateCompatibleBitmap(screen, width, height);
        var previous = Native.SelectObject(memory, bitmap);
        try
        {
            // CAPTUREBLT includes layered windows, which is what makes a
            // translucent overlay part of the picture rather than a hole in it.
            if (!Native.BitBlt(
                    memory, 0, 0, width, height, screen, region.Left, region.Top, Native.SRCCOPY | Native.CAPTUREBLT))
            {
                throw CuaException.Failed($"BitBlt failed for {Discovery.Describe(region)}");
            }
            if (showCursor) DrawCursor(memory, region);
            return ReadSurface(memory, bitmap, width, height);
        }
        finally
        {
            Native.SelectObject(memory, previous);
            Native.DeleteObject(bitmap);
            Native.DeleteDC(memory);
            Native.ReleaseDC(IntPtr.Zero, screen);
        }
    }

    /// <summary>Capture one window, even when it is covered.</summary>
    private static Surface CaptureWindow(IntPtr window, Native.RECT region, bool showCursor)
    {
        var bounds = Native.WindowBounds(window);
        var width = Math.Max(bounds.Width, 1);
        var height = Math.Max(bounds.Height, 1);

        var screen = Native.GetDC(IntPtr.Zero);
        if (screen == IntPtr.Zero) throw CuaException.Failed("the screen device context could not be opened");
        var memory = Native.CreateCompatibleDC(screen);
        var bitmap = Native.CreateCompatibleBitmap(screen, width, height);
        var previous = Native.SelectObject(memory, bitmap);
        try
        {
            var drawn = Native.PrintWindow(window, memory, Native.PW_RENDERFULLCONTENT);
            var probe = drawn ? ReadSurface(memory, bitmap, width, height) : null;
            if (probe is not null && !IsBlank(probe))
            {
                // The cursor is drawn into the same device context that already
                // holds the window, so it composites at the right offset without
                // a second capture.
                if (showCursor) DrawCursor(memory, bounds);
                return Crop(ReadSurface(memory, bitmap, width, height), bounds, region);
            }

            // The window declined to draw itself — a hardware-protected or
            // still-initialising surface. Fall back to whatever is on screen at
            // its rectangle, which is correct whenever it is not covered.
            Program.WriteDiagnostic(
                $"PrintWindow produced no content for window 0x{window.ToInt64():X}; falling back to the screen");
            return Crop(CaptureScreen(bounds, showCursor), bounds, region);
        }
        finally
        {
            Native.SelectObject(memory, previous);
            Native.DeleteObject(bitmap);
            Native.DeleteDC(memory);
            Native.ReleaseDC(IntPtr.Zero, screen);
        }
    }

    /// <summary>Whether a captured surface carries no content at all.</summary>
    private static bool IsBlank(Surface surface)
    {
        var pixels = surface.Pixels;
        if (pixels.Length < 4) return true;
        // Sampling a grid rather than every pixel: "did anything draw" does not
        // need five million comparisons, and a real UI differs somewhere.
        var step = Math.Max(4, pixels.Length / 4096 / 4 * 4);
        var first = (pixels[0], pixels[1], pixels[2]);
        for (var offset = 0; offset + 3 < pixels.Length; offset += step)
        {
            if ((pixels[offset], pixels[offset + 1], pixels[offset + 2]) != first) return false;
        }
        return first is (0, 0, 0) or (255, 255, 255);
    }

    /// <summary>Re-cut a window-sized surface down to the requested region.</summary>
    private static Surface Crop(Surface surface, Native.RECT bounds, Native.RECT region)
    {
        if (bounds.Left == region.Left && bounds.Top == region.Top
            && bounds.Width == region.Width && bounds.Height == region.Height)
        {
            return surface;
        }
        var width = Math.Max(region.Width, 1);
        var height = Math.Max(region.Height, 1);
        var cropped = new byte[width * height * 4];
        var offsetX = Math.Max(region.Left - bounds.Left, 0);
        var offsetY = Math.Max(region.Top - bounds.Top, 0);
        var copyWidth = Math.Min(width, Math.Max(surface.Width - offsetX, 0));
        if (copyWidth <= 0) return new Surface(cropped, width, height);
        for (var row = 0; row < height; row++)
        {
            var sourceRow = row + offsetY;
            if (sourceRow < 0 || sourceRow >= surface.Height) continue;
            Array.Copy(surface.Pixels, (sourceRow * surface.Width + offsetX) * 4, cropped, row * width * 4, copyWidth * 4);
        }
        return new Surface(cropped, width, height);
    }

    private static void DrawCursor(IntPtr dc, Native.RECT region)
    {
        var info = new Native.CURSORINFO { Size = System.Runtime.InteropServices.Marshal.SizeOf<Native.CURSORINFO>() };
        if (!Native.GetCursorInfo(ref info)) return;
        if ((info.Flags & Native.CURSOR_SHOWING) == 0 || info.Cursor == IntPtr.Zero) return;

        var icon = new Native.ICONINFO();
        if (!Native.GetIconInfo(info.Cursor, ref icon)) return;
        try
        {
            // The icon's hotspot is where the pointer actually is, so the bitmap
            // has to be offset by it for the arrow tip to land on the point.
            var x = info.ScreenPosition.X - region.Left - (int)icon.HotspotX;
            var y = info.ScreenPosition.Y - region.Top - (int)icon.HotspotY;
            Native.DrawIconEx(dc, x, y, info.Cursor, 0, 0, 0, IntPtr.Zero, Native.DI_NORMAL);
        }
        finally
        {
            if (icon.MaskBitmap != IntPtr.Zero) Native.DeleteObject(icon.MaskBitmap);
            if (icon.ColorBitmap != IntPtr.Zero) Native.DeleteObject(icon.ColorBitmap);
        }
    }

    private static Surface ReadSurface(IntPtr dc, IntPtr bitmap, int width, int height)
    {
        var pixels = new byte[width * height * 4];
        var info = new Native.BITMAPINFO
        {
            Size = 40,
            Width = width,
            // A negative height requests a top-down bitmap, which is the row
            // order the rest of the pipeline (and WPF's Bgra32) expects.
            Height = -height,
            Planes = 1,
            BitCount = 32,
            Compression = 0,
        };
        var rows = Native.GetDIBits(dc, bitmap, 0, (uint)height, pixels, ref info, Native.DIB_RGB_COLORS);
        if (rows == 0) throw CuaException.Failed("the captured bitmap could not be read back");
        return new Surface(pixels, width, height);
    }

    // MARK: - Scaling and encoding

    /// <summary>Shrink to the requested cap and report the delivered size.</summary>
    private static (BitmapSource Image, int Width, int Height) Downscale(Surface surface, int maxWidth, int maxHeight)
    {
        var source = BitmapSource.Create(
            surface.Width, surface.Height, 96, 96, PixelFormats.Bgra32, null, surface.Pixels, surface.Width * 4);
        source.Freeze();

        // Windows captures at 1:1 — a physical pixel is the unit everywhere in
        // this engine — so the only scaling that ever happens is the caller's
        // explicit cap, and the reported scale describes the delivered image.
        var factor = Math.Min(1.0, Math.Min(maxWidth / (double)surface.Width, maxHeight / (double)surface.Height));
        if (factor >= 1.0) return (source, surface.Width, surface.Height);

        var width = Math.Max(1, (int)Math.Round(surface.Width * factor));
        var height = Math.Max(1, (int)Math.Round(surface.Height * factor));
        var transformed = new TransformedBitmap(
            source, new ScaleTransform(width / (double)surface.Width, height / (double)surface.Height));
        transformed.Freeze();
        return (transformed, width, height);
    }

    private static (string Data, string MimeType, int ByteLength) Encode(
        BitmapSource image, string format, double quality)
    {
        BitmapEncoder encoder = format == "jpeg"
            ? new JpegBitmapEncoder { QualityLevel = Math.Clamp((int)Math.Round(quality * 100), 10, 100) }
            : new PngBitmapEncoder();
        encoder.Frames.Add(BitmapFrame.Create(image));
        using var stream = new MemoryStream();
        encoder.Save(stream);
        var bytes = stream.ToArray();
        return (Convert.ToBase64String(bytes), format == "jpeg" ? "image/jpeg" : "image/png", bytes.Length);
    }
}
