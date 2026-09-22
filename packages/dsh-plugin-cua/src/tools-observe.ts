/**
 * Observation tools: engine status, applications, windows, accessibility tree,
 * and screen capture.
 *
 * These are the "perceive" half of the loop. None of them is write-gated: they
 * report what the machine already shows, and the operating system gates them
 * itself through Accessibility and Screen Recording.
 *
 * @module
 */

import { mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { defineTool, type ToolDefinition } from '@deepseek-ai/dsh-tools'
import {
  arr, formatWindow, num, obj, str, text, toAppRow, toPermissionReport, toTreeNode, toWindowRow,
  type PermissionReport, type ToolContext,
} from './shared.ts'

/** The tree node shape the engine emits, as the tool's canonical value. */
const TREE_NODE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    depth: { type: 'integer', required: true },
    role: { type: 'string', required: true },
    title: { type: 'string', required: true },
    value: { type: 'string', required: true },
    description: { type: 'string', required: true },
    placeholder: { type: 'string', required: true },
    actionable: { type: 'boolean', required: true },
    enabled: { type: 'boolean', required: true },
    focused: { type: 'boolean', required: true },
    selected: { type: 'boolean', required: true },
    frame: { type: 'array', items: { type: 'number' } },
  },
} as const

/** Observation tools contributed by the Computer Use plugin. */
export function observationTools(ctx: Context, tools: ToolContext): ToolDefinition[] {
  return [
    statusTool(ctx, tools),
    displaysTool(tools),
    appsTool(tools),
    windowsTool(tools),
    treeTool(tools),
    screenshotTool(tools),
  ]
}

/** `cua_status`: permissions, engine identity, and how to fix what is missing. */
function statusTool(ctx: Context, tools: ToolContext): ToolDefinition {
  return defineTool({
    name: 'cua_status',
    description: 'Report the state of the Computer Use engine: which operating system it drives, which permissions macOS has granted it, and exactly what to do about any that are missing. '
      + 'Call this first whenever a Computer Use tool reports a permission problem, and before promising a user that screenshots or input will work. '
      + 'It also reports whether the screen is locked, which blocks captures and makes input unreliable. '
      + 'With request=true it also raises the macOS permission prompts.',
    parameters: {
      request: { type: 'boolean', description: 'Raise the macOS permission prompts for anything still missing. The user still has to confirm in System Settings.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          engineVersion: { type: 'string', required: true },
          backend: { type: 'string', required: true },
          platform: { type: 'string', required: true },
          platformVersion: { type: 'string', required: true },
          accessibility: { type: 'boolean', required: true },
          screenRecording: { type: 'boolean', required: true },
          ready: { type: 'boolean', required: true },
          sessionLocked: { type: 'boolean', required: true },
          missing: { type: 'array', items: { type: 'string' }, required: true },
          hint: { type: 'string', required: true },
          enginePath: { type: 'string', required: true },
          eligibleTools: { type: 'array', items: { type: 'string' }, required: true },
        },
      },
      render: (_args, value) => text(renderStatus(value)),
    },
    async execute(args, exec) {
      const raw = args.request === true
        ? await tools.engine.request<Record<string, unknown>>({ method: 'engine.request_permissions', timeoutMs: 20_000, signal: exec.signal })
        : await tools.engine.request<Record<string, unknown>>({ method: 'engine.status', timeoutMs: 10_000, signal: exec.signal })
      // `engine.status` nests the permission report under `permissions`; reading
      // the outer object would silently report every permission as missing.
      const report = toPermissionReport(raw.permissions ?? raw)
      const engineVersion = str(raw.engine, 'unknown')
      const backend = str(raw.backend, 'unknown')
      return {
        engineVersion,
        backend,
        platform: report.platform,
        platformVersion: report.platformVersion,
        accessibility: report.accessibility,
        screenRecording: report.screenRecording,
        ready: report.ready,
        sessionLocked: report.sessionLocked,
        missing: report.missing,
        hint: report.hint,
        enginePath: tools.engine.executablePath,
        eligibleTools: eligibleTools(report),
      }
    },
  })
}

/** Which tool families the current permissions support. */
function eligibleTools(report: PermissionReport): string[] {
  const available: string[] = [
    'cua_displays',
    'cua_apps',
    'cua_windows',
    'cua_app (launch, openURL, reveal, quit, hide, script)',
  ]
  if (report.accessibility) {
    available.push('cua_tree', 'cua_click', 'cua_type', 'cua_key', 'cua_element')
  }
  if (report.screenRecording) {
    available.push(report.sessionLocked ? 'cua_screenshot (blocked while the screen is locked)' : 'cua_screenshot')
  }
  return available
}

/** Render the status report for a model. */
function renderStatus(value: {
  engineVersion: string
  backend: string
  platform: string
  platformVersion: string
  accessibility: boolean
  screenRecording: boolean
  ready: boolean
  sessionLocked: boolean
  missing: string[]
  hint: string
  enginePath: string
  eligibleTools: string[]
}): string {
  const permission = (granted: boolean): string => granted ? 'granted' : 'MISSING'
  const lines = [
    `Computer Use engine ${value.engineVersion} on ${value.platform} ${value.platformVersion} (backend ${value.backend}).`,
    `Accessibility: ${permission(value.accessibility)}. Screen Recording: ${permission(value.screenRecording)}. `
      + `Screen: ${value.sessionLocked ? 'LOCKED' : 'unlocked'}.`,
    `Engine binary: ${value.enginePath}`,
    '',
    value.ready ? 'All permissions are granted and the screen is unlocked.' : value.hint,
    '',
    `Available with the current permissions: ${value.eligibleTools.join(', ')}.`,
  ]
  return lines.join('\n')
}

/** `cua_displays`: the display layout, so coordinates can be computed at all. */
function displaysTool(tools: ToolContext): ToolDefinition {
  return defineTool({
    name: 'cua_displays',
    description: 'Describe the display layout: each screen\'s id, its rectangle in top-left-origin screen points, and its pixel density. '
      + 'Call this before computing coordinates by hand on a multi-display machine — secondary displays can sit at negative x or y, and each may have a different pixel density, so neither the valid ranges nor the screenshot scale can be assumed. '
      + 'Requires no macOS permission.',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          count: { type: 'integer', required: true },
          desktop: { type: 'array', items: { type: 'number' }, required: true },
          coordinateSpace: { type: 'string', required: true },
          displays: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                displayId: { type: 'integer', required: true },
                frame: { type: 'array', items: { type: 'number' }, required: true },
                reportedDensity: { type: 'number', required: true },
                main: { type: 'boolean', required: true },
              },
            },
          },
        },
      },
      render: (_args, value) => {
        const lines = value.displays.map(display => {
          const frame = display.frame
          if (frame.length !== 4) return `display ${String(display.displayId)}: geometry unavailable`
          const [x = 0, y = 0, width = 0, height = 0] = frame
          const role = display.main ? ' (main)' : ''
          return `display ${String(display.displayId)}${role}: x ${String(x)}…${String(x + width)}, `
            + `y ${String(y)}…${String(y + height)} (${String(width)}x${String(height)} points)`
        })
        return text(
          `${value.count} display(s). ${value.coordinateSpace}\n`
          + `Desktop bounding box: x=${String(value.desktop[0])} y=${String(value.desktop[1])} `
          + `width=${String(value.desktop[2])} height=${String(value.desktop[3])}.\n`
          + `${lines.join('\n')}\n`
          + 'Only points inside one of these rectangles exist; anything else is rejected. '
          + 'The authoritative pixel density of a capture is the `scale` that capture returns, not the value listed here.',
        )
      },
    },
    async execute(_args, exec) {
      const raw = await tools.engine.request<Record<string, unknown>>({
        method: 'display.list',
        timeoutMs: 15_000,
        signal: exec.signal,
      })
      return {
        count: num(raw.count),
        desktop: arr(raw.desktop).map(entry => num(entry)),
        coordinateSpace: str(raw.coordinateSpace),
        displays: arr(raw.displays).map(entry => {
          const row = obj(entry)
          return {
            displayId: num(row.displayId, -1),
            frame: arr(row.frame).map(value => num(value)),
            reportedDensity: num(row.reportedDensity, 1),
            main: row.main === true,
          }
        }),
      }
    },
  })
}

/** `cua_apps`: running or installed applications. */
function appsTool(tools: ToolContext): ToolDefinition {
  return defineTool({
    name: 'cua_apps',
    description: 'List applications on this machine: running applications by default, or everything installed under the standard application directories. '
      + 'Use it to discover the exact name, bundle id, or pid that the other Computer Use tools take as a target. '
      + 'Requires no macOS permission.',
    parameters: {
      query: { type: 'string', description: 'Case-insensitive substring matched against the application name and bundle id.' },
      running: { type: 'boolean', description: 'List running applications (default true) instead of installed ones.' },
      includeBackground: { type: 'boolean', description: 'Include windowless background helpers such as WebKit content processes. Off by default because they are rarely the intended target.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          count: { type: 'integer', required: true },
          apps: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                name: { type: 'string', required: true },
                bundleId: { type: 'string', required: true },
                pid: { type: 'integer', required: true },
                active: { type: 'boolean', required: true },
                hidden: { type: 'boolean', required: true },
                policy: { type: 'string', required: true },
              },
            },
          },
        },
      },
      render: (_args, value) => {
        if (value.apps.length === 0) return text('No application matched.')
        const lines = value.apps.map(app => {
          const pid = app.pid >= 0 ? ` pid=${app.pid}` : ''
          const state = app.active ? ' active' : app.hidden ? ' hidden' : ''
          return `${app.name} — ${app.bundleId}${pid}${state}`
        })
        return text(`${value.count} application(s):\n${lines.join('\n')}`)
      },
    },
    async execute(args, exec) {
      const raw = await tools.engine.request<Record<string, unknown>>({
        method: 'app.list',
        params: {
          ...args.query === undefined ? {} : { query: args.query },
          running: args.running ?? true,
          includeBackground: args.includeBackground ?? false,
        },
        timeoutMs: 15_000,
        signal: exec.signal,
      })
      return {
        count: num(raw.count),
        apps: arr(raw.apps).map(toAppRow).map(app => ({
          name: app.name,
          bundleId: app.bundleId,
          pid: app.pid,
          active: app.active,
          hidden: app.hidden,
          policy: app.policy,
        })),
      }
    },
  })
}

/** `cua_windows`: windows with the ids and frames the other tools need. */
function windowsTool(tools: ToolContext): ToolDefinition {
  return defineTool({
    name: 'cua_windows',
    description: 'List on-screen windows with their window id, owning application, title, and screen rectangle. '
      + 'The returned `windowId` feeds cua_screenshot and cua_tree; the `frame` is in global screen points with the origin at the top-left of the main display, which is the same space cua_click takes. '
      + 'Requires Accessibility permission.',
    parameters: {
      app: { type: 'string', description: 'Restrict to applications whose name or bundle id contains this text.' },
      pid: { type: 'integer', description: 'Restrict to one process id.' },
      frontmost: { type: 'boolean', description: 'Only the frontmost application.' },
      includeUntitled: { type: 'boolean', description: 'Include windows with no title, such as the Finder desktop (default true).' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          count: { type: 'integer', required: true },
          note: { type: 'string' },
          windows: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                title: { type: 'string', required: true },
                app: { type: 'string', required: true },
                pid: { type: 'integer', required: true },
                windowId: { type: 'integer' },
                frame: { type: 'array', items: { type: 'number' } },
                main: { type: 'boolean', required: true },
                focused: { type: 'boolean', required: true },
                minimized: { type: 'boolean', required: true },
              },
            },
          },
        },
      },
      render: (_args, value) => {
        if (value.windows.length === 0) {
          return text(value.note === undefined ? 'No window matched.' : `No window matched. ${value.note}`)
        }
        const lines = value.windows.map(window => formatWindow(toWindowRow(window)))
        const header = `${value.count} window(s); coordinates are top-left-origin screen points:`
        return text(`${header}\n${lines.join('\n')}`)
      },
    },
    async execute(args, exec) {
      const raw = await tools.engine.request<Record<string, unknown>>({
        method: 'window.list',
        params: {
          ...args.app === undefined ? {} : { app: args.app },
          ...args.pid === undefined ? {} : { pid: args.pid },
          frontmost: args.frontmost ?? false,
          includeUntitled: args.includeUntitled ?? true,
        },
        timeoutMs: 20_000,
        signal: exec.signal,
      })
      const note = str(raw.note)
      return {
        count: num(raw.count),
        ...note === '' ? {} : { note },
        windows: arr(raw.windows).map(toWindowRow).map(row => ({
          title: row.title,
          app: row.app,
          pid: row.pid,
          ...row.windowId === null ? {} : { windowId: row.windowId },
          ...row.frame === null ? {} : { frame: row.frame },
          main: row.main,
          focused: row.focused,
          minimized: row.minimized,
        })),
      }
    },
  })
}

/** `cua_tree`: the accessibility tree, the main way to see a UI without pixels. */
function treeTool(tools: ToolContext): ToolDefinition {
  return defineTool({
    name: 'cua_tree',
    description: 'Dump the accessibility tree of an application or window as one line per element, each prefixed with its index. '
      + 'This is the primary way to read a UI: it gives roles, titles, values, and states that a screenshot cannot, and it needs no vision. '
      + 'The index addresses the element in cua_element and as the `element` parameter of cua_click and cua_key, and stays valid until the next cua_tree for the same application. '
      + 'The tree is always truncated by a budget — the result names which one (`node_limit`, `visit_limit`, `depth`, `time_budget`); narrow the query by app, windowTitle, roles, or maxDepth rather than assuming you saw everything.',
    parameters: {
      app: { type: 'string', description: 'Application name or bundle id. Defaults to the frontmost application.' },
      pid: { type: 'integer', description: 'Target process id; wins over app.' },
      windowId: { type: 'integer', description: 'Dump only this window (from cua_windows).' },
      windowTitle: { type: 'string', description: 'Case-insensitive substring of the window title to dump.' },
      maxDepth: { type: 'integer', description: 'Maximum tree depth (default 8). Structural wrappers do not consume depth.' },
      nodeLimit: { type: 'integer', description: 'Maximum emitted nodes (default 1200).' },
      interactiveOnly: { type: 'boolean', description: 'Emit only elements a user can act on: buttons, fields, links, tabs, and menu items.' },
      roles: { type: 'array', items: { type: 'string' }, description: 'Keep only these accessibility roles, such as ["AXButton","AXTextField"]. Ancestors with text are kept so matches stay anchored.' },
      textLimit: { type: 'integer', description: 'Truncate every text value to this many characters (default 200).' },
      includeGeometry: { type: 'boolean', description: 'Include each element frame as [x, y, width, height] in top-left-origin screen points. Needed before clicking an element by coordinate.' },
      includeStructural: { type: 'boolean', description: 'Include layout wrappers such as AXGroup and AXScrollArea, which are otherwise folded away.' },
      includeMenuBar: { type: 'boolean', description: 'Include the menu bar hierarchy, which is skipped by default.' },
      timeBudgetMs: { type: 'integer', description: 'Wall-clock budget for the walk (default 8000).' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          app: { type: 'string', required: true },
          pid: { type: 'integer', required: true },
          windowTitle: { type: 'string' },
          nodeCount: { type: 'integer', required: true },
          visitedCount: { type: 'integer', required: true },
          truncatedBy: { type: 'string' },
          elapsedMs: { type: 'integer', required: true },
          outline: { type: 'string', required: true },
          nodes: { type: 'array', required: true, items: TREE_NODE_SCHEMA },
        },
      },
      render: (_args, value) => {
        const truncated = value.truncatedBy === undefined
          ? ''
          : `\n\nTRUNCATED by ${value.truncatedBy}: this is a partial view. Narrow it with roles, maxDepth, windowId, or a larger nodeLimit.`
        const header = `${value.app} (pid ${value.pid})${value.windowTitle === undefined ? '' : ` — window "${value.windowTitle}"`}: `
          + `${value.nodeCount} node(s) shown, ${value.visitedCount} visited, ${value.elapsedMs}ms. `
          + 'Indices address elements in cua_element / cua_click / cua_key; "actionable" marks elements a user can act on.'
        const outline = value.outline === '' ? '(no element matched the filter)' : value.outline
        return text(`${header}\n\n${outline}${truncated}`)
      },
    },
    async execute(args, exec) {
      const roles = args.roles ?? []
      const raw = await tools.engine.request<Record<string, unknown>>({
        method: 'tree.dump',
        params: {
          ...args.app === undefined ? {} : { app: args.app },
          ...args.pid === undefined ? {} : { pid: args.pid },
          ...args.windowId === undefined ? {} : { windowId: args.windowId },
          ...args.windowTitle === undefined ? {} : { windowTitle: args.windowTitle },
          ...args.maxDepth === undefined ? {} : { maxDepth: args.maxDepth },
          ...args.nodeLimit === undefined ? {} : { nodeLimit: args.nodeLimit },
          ...args.interactiveOnly === undefined ? {} : { interactiveOnly: args.interactiveOnly },
          ...roles.length === 0 ? {} : { roles },
          ...args.textLimit === undefined ? {} : { textLimit: args.textLimit },
          ...args.includeGeometry === undefined ? {} : { includeGeometry: args.includeGeometry },
          ...args.includeStructural === undefined ? {} : { includeStructural: args.includeStructural },
          includeMenuBar: args.includeMenuBar ?? false,
          ...args.timeBudgetMs === undefined ? {} : { timeBudgetMs: args.timeBudgetMs },
        },
        timeoutMs: (args.timeBudgetMs ?? 8_000) + 15_000,
        signal: exec.signal,
      })
      const windowTitle = str(raw.windowTitle)
      const truncatedBy = str(raw.truncatedBy)
      return {
        app: str(raw.app),
        pid: num(raw.pid, -1),
        ...windowTitle === '' ? {} : { windowTitle },
        nodeCount: num(raw.nodeCount),
        visitedCount: num(raw.visitedCount),
        ...truncatedBy === '' ? {} : { truncatedBy },
        elapsedMs: num(raw.elapsedMs),
        outline: str(raw.text),
        nodes: arr(raw.nodes).map(toTreeNode),
      }
    },
  })
}

/** `cua_screenshot`: pixels, saved to a file that can be read back as an image. */
function screenshotTool(tools: ToolContext): ToolDefinition {
  return defineTool({
    name: 'cua_screenshot',
    description: 'Capture a window, a display, or a rectangle of the screen and save it as a PNG or JPEG file. '
      + 'The file path is returned; read it with the read_image tool to actually see the pixels. '
      + 'Prefer cua_tree for reading a UI — use screenshots for canvas content, images, rendered layout, and anything the accessibility tree does not expose. '
      + 'The result reports `region` (the captured rectangle in top-left-origin screen points) and `scale` (image pixels per screen point), so a feature seen at image pixel (px, py) is clicked at screen point (region.x + px/scale, region.y + py/scale). '
      + 'On a multi-display setup `scale` differs per display — use the scale from this result, never a remembered one — and `displayId` names which screen the capture came from. Call cua_displays to see the layout before computing coordinates by hand. '
      + 'Requires Screen Recording permission.',
    parameters: {
      windowId: { type: 'integer', description: 'Capture this window (from cua_windows). Captures the window itself, even if another window covers it.' },
      pid: { type: 'integer', description: 'Capture the main window of this process.' },
      app: { type: 'string', description: 'Capture the frontmost window of the named application.' },
      displayId: { type: 'integer', description: 'Capture a whole display by id.' },
      windowTitle: { type: 'string', description: 'With pid or app, pick the window whose title contains this text.' },
      x: { type: 'integer', description: 'Left edge of a region to capture, in screen points. Requires y, width, and height.' },
      y: { type: 'integer', description: 'Top edge of the region, in screen points.' },
      width: { type: 'integer', description: 'Region width in screen points.' },
      height: { type: 'integer', description: 'Region height in screen points.' },
      format: { type: 'string', enum: ['png', 'jpeg'], description: 'Image format (default png; jpeg is smaller for photographic content).' },
      quality: { type: 'number', description: 'JPEG quality 0.1–1.0 (default 0.8).' },
      maxWidth: { type: 'integer', description: 'Downscale so the image is at most this many pixels wide.' },
      maxHeight: { type: 'integer', description: 'Downscale so the image is at most this many pixels tall.' },
      showCursor: { type: 'boolean', description: 'Draw the mouse cursor into the capture (default false).' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          path: { type: 'string', required: true },
          mimeType: { type: 'string', required: true },
          pixelWidth: { type: 'integer', required: true },
          pixelHeight: { type: 'integer', required: true },
          byteLength: { type: 'integer', required: true },
          region: { type: 'array', items: { type: 'number' }, required: true },
          scale: { type: 'number', required: true },
          scaleY: { type: 'number', required: true },
          clipped: { type: 'boolean', required: true },
          displayId: { type: 'integer' },
          target: { type: 'string', required: true },
        },
      },
      render: (_args, value) => {
        const onDisplay = value.displayId === undefined ? '' : ` on display ${String(value.displayId)}`
        const axes = value.scaleY === value.scale
          ? `${value.scale}`
          : `${value.scale} horizontally and ${value.scaleY} vertically`
        return text(
          `<path>${value.path}</path>\n`
          + `Captured ${value.target}${onDisplay}: ${value.pixelWidth}x${value.pixelHeight} px (${value.byteLength} bytes, ${value.mimeType}).\n`
          + `Captured screen region: x=${value.region[0]} y=${value.region[1]} width=${value.region[2]} height=${value.region[3]} `
          + `(top-left-origin screen points); image pixels per screen point = ${axes}.\n`
          + (value.clipped
            ? 'NOTE: the requested rectangle was clipped to the display it overlaps; `region` above is the area actually captured.\n'
            : '')
          + 'To see it, read this path with read_image. To click something you see at image pixel (px, py), '
          + `click (${value.region[0]} + px/${value.scale}, ${value.region[1]} + py/${value.scaleY}).`,
        )
      },
    },
    async execute(args, exec) {
      const maxDimension = tools.maxCaptureDimension
      const raw = await tools.engine.request<Record<string, unknown>>({
        method: 'capture.screenshot',
        params: {
          ...args.windowId === undefined ? {} : { windowId: args.windowId },
          ...args.pid === undefined ? {} : { pid: args.pid },
          ...args.app === undefined ? {} : { app: args.app },
          ...args.displayId === undefined ? {} : { displayId: args.displayId },
          ...args.windowTitle === undefined ? {} : { windowTitle: args.windowTitle },
          ...args.x === undefined ? {} : { x: args.x },
          ...args.y === undefined ? {} : { y: args.y },
          ...args.width === undefined ? {} : { width: args.width },
          ...args.height === undefined ? {} : { height: args.height },
          format: args.format ?? 'png',
          ...args.quality === undefined ? {} : { quality: args.quality },
          maxWidth: args.maxWidth ?? maxDimension,
          maxHeight: args.maxHeight ?? maxDimension,
          showCursor: args.showCursor ?? false,
        },
        timeoutMs: 45_000,
        signal: exec.signal,
      })

      const data = str(raw.data)
      if (data === '') throw new Error('the engine returned a capture with no image data')
      const mimeType = str(raw.mimeType, 'image/png')
      const bytes = Buffer.from(data, 'base64')
      const directory = tools.screenshotDir ?? join(tmpdir(), 'dsh-cua')
      await mkdir(directory, { recursive: true })
      const extension = mimeType === 'image/jpeg' ? 'jpg' : 'png'
      const stamp = new Date().toISOString().replaceAll(/[:.]/gu, '-')
      const path = join(directory, `cua-${stamp}-${String(exec.callId).slice(-6)}.${extension}`)
      await writeFile(path, bytes)

      const region = arr(raw.region).map(entry => num(entry))
      return {
        path,
        mimeType,
        pixelWidth: num(raw.pixelWidth),
        pixelHeight: num(raw.pixelHeight),
        byteLength: bytes.byteLength,
        region: region.length === 4 ? region : [0, 0, 0, 0],
        scale: num(raw.scale, 1),
        scaleY: num(raw.scaleY, num(raw.scale, 1)),
        clipped: raw.clipped === true,
        ...typeof raw.displayId === 'number' ? { displayId: raw.displayId } : {},
        target: describeTarget(raw, args),
      }
    },
  })
}

/** Name what was captured, for the model-facing summary. */
function describeTarget(raw: Record<string, unknown>, args: { windowId?: number, pid?: number, app?: string, displayId?: number }): string {
  const windowId = raw.windowId
  if (typeof windowId === 'number') return `window ${windowId}`
  const displayId = raw.displayId
  if (typeof displayId === 'number') return `display ${displayId}`
  if (args.app !== undefined) return `the frontmost window of ${args.app}`
  if (args.pid !== undefined) return `the main window of pid ${args.pid}`
  return 'the screen'
}
