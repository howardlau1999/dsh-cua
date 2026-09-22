/**
 * Interaction tools: pointer, keyboard, and direct element actions.
 *
 * These are the "act" half of the loop. Every one of them is write-gated
 * (see `approval.ts`) and every one reports what it actually did — the resolved
 * screen point, the number of clicks, the keys pressed — so the model can verify
 * its own action instead of assuming it landed.
 *
 * @module
 */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool, type ToolDefinition } from '@deepseek-ai/dsh-tools'
import { requireWriteApproval } from './approval.ts'
import type { WriteApprovalMode } from './config.ts'
import { arr, bool, num, str, text, type ToolContext } from './shared.ts'
import { copy } from './platform.ts'

/** Coordinates and target shared by every pointer tool. */
const POINT_PARAMETERS = {
  x: { type: 'number', description: 'Horizontal position in top-left-origin screen coordinates, as reported by cua_windows frames or cua_tree geometry.' },
  y: { type: 'number', description: 'Vertical position in top-left-origin screen coordinates.' },
  element: { type: 'integer', description: 'Target a cua_tree index instead of coordinates. The element snapshot must come from the most recent cua_tree call.' },
} as const

/** Interaction tools contributed by the Computer Use plugin. */
export function interactionTools(ctx: Context, tools: ToolContext, mode: WriteApprovalMode): ToolDefinition[] {
  return [
    clickTool(ctx, tools, mode),
    typeTool(ctx, tools, mode),
    keyTool(ctx, tools, mode),
    elementTool(ctx, tools, mode),
  ]
}

/** `cua_click`: pointer clicks, drags, and scrolling. */
function clickTool(ctx: Context, tools: ToolContext, mode: WriteApprovalMode): ToolDefinition {
  return defineTool({
    name: 'cua_click',
    description: 'Move the pointer and click, drag, or scroll on the real desktop. '
      + 'Coordinates are top-left-origin screen coordinates: the same space as cua_windows frames and cua_tree geometry, and the space cua_screenshot converts image pixels into. '
      + 'Prefer targeting an `element` index from cua_tree over raw coordinates — it survives layout changes and the result tells you what was actually hit. '
      + `Delivery: ${copy.routeHelp} `
      + copy.treePermission,
    parameters: {
      action: { type: 'string', enum: ['click', 'move', 'scroll', 'drag', 'down', 'up'], description: 'Pointer action (default click).' },
      ...POINT_PARAMETERS,
      toX: { type: 'number', description: 'For action=drag: destination x.' },
      toY: { type: 'number', description: 'For action=drag: destination y.' },
      clickCount: { type: 'integer', description: 'Click count: 2 double-clicks, 3 triple-clicks (default 1).' },
      button: { type: 'string', enum: ['left', 'right', 'middle'], description: 'Mouse button (default left).' },
      dx: { type: 'number', description: 'For action=scroll: horizontal scroll in pixels; positive scrolls content right.' },
      dy: { type: 'number', description: 'For action=scroll: vertical scroll in pixels; positive scrolls content down.' },
      durationMs: { type: 'integer', description: 'For action=drag: total drag duration (default 300).' },
      steps: { type: 'integer', description: 'For action=drag: intermediate move events (default 12). More steps suit slow, precise drags.' },
      route: { type: 'string', enum: ['post', 'pid'], description: 'Delivery route (default post).' },
      pid: { type: 'integer', description: 'Target process id for route=pid, or to resolve an element index.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          delivered: { type: 'boolean', required: true },
          action: { type: 'string', required: true },
          route: { type: 'string', required: true },
          screenX: { type: 'number' },
          screenY: { type: 'number' },
          clickCount: { type: 'integer' },
          button: { type: 'string' },
          fromScreen: { type: 'array', items: { type: 'number' } },
          toScreen: { type: 'array', items: { type: 'number' } },
          dx: { type: 'number' },
          dy: { type: 'number' },
        },
      },
      render: (_args, value) => text(renderPointer(value)),
    },
    async execute(args, exec) {
      const action = args.action ?? 'click'
      const target = args.element === undefined
        ? args.x === undefined ? 'the pointer\'s current position' : `(${String(args.x)}, ${String(args.y)})`
        : `element #${String(args.element)}`
      await requireWriteApproval({
        mode,
        ctx,
        exec,
        reason: `Computer Use wants to ${action} at ${target} on your desktop.`,
      })

      const params: Record<string, unknown> = {
        action,
        route: args.route ?? 'post',
        button: args.button ?? 'left',
        ...args.x === undefined ? {} : { x: args.x },
        ...args.y === undefined ? {} : { y: args.y },
        ...args.element === undefined ? {} : { element: args.element },
        ...args.pid === undefined ? {} : { pid: args.pid },
      }
      if (action === 'click') params.clickCount = args.clickCount ?? 1
      if (action === 'scroll') {
        params.dx = args.dx ?? 0
        params.dy = args.dy ?? 0
      }
      if (action === 'drag') {
        params.fromX = args.x
        params.fromY = args.y
        params.toX = args.toX
        params.toY = args.toY
        if (args.toX === undefined || args.toY === undefined) {
          throw new Error('action=drag needs toX and toY as well as x and y (the start point)')
        }
        params.steps = args.steps ?? 12
        params.durationMs = args.durationMs ?? 300
      }

      const raw = await tools.engine.request<Record<string, unknown>>({
        method: 'pointer',
        params,
        timeoutMs: 30_000,
        signal: exec.signal,
      })
      const from = arr(raw.fromScreen).map(entry => num(entry))
      const to = arr(raw.toScreen).map(entry => num(entry))
      return {
        delivered: bool(raw.delivered),
        action,
        route: str(raw.route, args.route ?? 'post'),
        ...typeof raw.screenX === 'number' ? { screenX: num(raw.screenX) } : {},
        ...typeof raw.screenY === 'number' ? { screenY: num(raw.screenY) } : {},
        ...typeof raw.clickCount === 'number' ? { clickCount: num(raw.clickCount) } : {},
        ...typeof raw.button === 'string' ? { button: str(raw.button) } : {},
        ...from.length === 2 ? { fromScreen: from } : {},
        ...to.length === 2 ? { toScreen: to } : {},
        ...typeof raw.dx === 'number' ? { dx: num(raw.dx) } : {},
        ...typeof raw.dy === 'number' ? { dy: num(raw.dy) } : {},
      }
    },
  })
}

/** Render what a pointer call did. */
function renderPointer(value: {
  delivered: boolean
  action: string
  route: string
  screenX?: number
  screenY?: number
  clickCount?: number
  button?: string
  fromScreen?: number[]
  toScreen?: number[]
  dx?: number
  dy?: number
}): string {
  if (!value.delivered) {
    return `The ${value.action} was not delivered. The target may have moved or the engine may lack Accessibility permission; call cua_status to check.`
  }
  const route = value.route === 'pid'
    ? ' (sent directly to the process; the visible cursor did not move)'
    : ''
  switch (value.action) {
    case 'click':
      return `Clicked ${value.button ?? 'left'} x${String(value.clickCount ?? 1)} at screen point (${String(value.screenX)}, ${String(value.screenY)})${route}. `
        + 'Verify the result with cua_tree or cua_screenshot before assuming it landed.'
    case 'move':
      return `Pointer moved to (${String(value.screenX)}, ${String(value.screenY)})${route}.`
    case 'scroll':
      return `Scrolled by dx=${String(value.dx ?? 0)}, dy=${String(value.dy ?? 0)} at (${String(value.screenX)}, ${String(value.screenY)})${route}.`
    case 'drag':
      return `Dragged from (${value.fromScreen?.join(', ') ?? '?'}) to (${value.toScreen?.join(', ') ?? '?'})${route}.`
    default:
      return `Pointer action "${value.action}" delivered at (${String(value.screenX)}, ${String(value.screenY)})${route}.`
  }
}

/** `cua_type`: text entry. */
function typeTool(ctx: Context, tools: ToolContext, mode: WriteApprovalMode): ToolDefinition {
  return defineTool({
    name: 'cua_type',
    description: 'Type text as keyboard input. '
      + `Pass \`element\` (a cua_tree index) whenever you know the field: ${copy.backgroundTyping}. `
      + 'Without `element` the text goes to whatever currently has keyboard focus on the frontmost application, and a background application silently ignores it. '
      + 'Unicode is delivered through the event payload rather than by key mapping, so CJK, emoji, and accented text work on any keyboard layout. '
      + 'For shortcuts use cua_key instead — typing the characters of a shortcut here would enter them literally. '
      + copy.treePermission,
    parameters: {
      text: { type: 'string', required: true, description: 'The text to type.' },
      element: { type: 'integer', description: 'A cua_tree index to focus and type into. Strongly preferred: it makes the target explicit and works on a background window.' },
      perCharacterDelayMs: { type: 'integer', description: 'Delay between characters. Some applications drop fast synthetic input; 10–30ms is usually enough.' },
      route: { type: 'string', enum: ['post', 'pid'], description: 'Delivery route when no element is named (default post). "pid" needs a foreground-focused target to have any effect.' },
      pid: { type: 'integer', description: 'Process id owning the element, or the route=pid target.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          delivered: { type: 'boolean', required: true },
          characters: { type: 'integer', required: true },
          route: { type: 'string', required: true },
        },
      },
      render: (args, value) => {
        if (!value.delivered) {
          return text('The text was not delivered; call cua_status to check Accessibility permission.')
        }
        const target = args.element === undefined
          ? 'into whatever had keyboard focus'
          : `into element #${String(args.element)}`
        return text(
          `Sent ${value.characters} character(s) ${target}.`
          + (args.element === undefined
            ? ' Nothing was focused for you, so a background application will have ignored this: '
              + 're-read cua_tree with interactiveOnly and pass that element index instead.'
            : ' Verify with cua_tree — for a text field, its value should now contain the text.'),
        )
      },
    },
    async execute(args, exec) {
      if (args.text.length === 0) throw new Error('text must not be empty')
      await requireWriteApproval({
        mode,
        ctx,
        exec,
        reason: `Computer Use wants to type ${args.text.length} character(s) into the focused field on your desktop: `
          + `"${args.text.length > 80 ? `${args.text.slice(0, 80)}…` : args.text}".`,
      })
      const raw = await tools.engine.request<Record<string, unknown>>({
        method: 'keyboard',
        params: {
          action: 'type',
          text: args.text,
          route: args.route ?? 'post',
          ...args.perCharacterDelayMs === undefined ? {} : { perCharacterDelayMs: args.perCharacterDelayMs },
          ...args.element === undefined ? {} : { element: args.element },
          ...args.pid === undefined ? {} : { pid: args.pid },
        },
        // Long text at a delay is legitimately slow; scale the deadline with it.
        timeoutMs: 30_000 + args.text.length * (args.perCharacterDelayMs ?? 0),
        signal: exec.signal,
      })
      return {
        delivered: bool(raw.delivered),
        characters: num(raw.characters),
        route: str(raw.route, args.route ?? 'post'),
      }
    },
  })
}

/** `cua_key`: named keys and modifier chords. */
function keyTool(ctx: Context, tools: ToolContext, mode: WriteApprovalMode): ToolDefinition {
  return defineTool({
    name: 'cua_key',
    description: 'Press a named key or a chord such as cmd+s, cmd+shift+t, or ctrl+c. '
      + 'The key name identifies a physical key position, so the shortcut is the same on every keyboard layout. '
      + 'Names: letters and digits as written, plus return, tab, space, delete, escape, arrows (left/right/up/down), home, end, pageup, pagedown, f1–f20, keypad_* names, and the modifiers themselves. '
      + `Modifiers: ${copy.modifiers}. `
      + copy.treePermission,
    parameters: {
      key: { type: 'string', required: true, description: 'Key name, such as "s", "return", "left", "f5", or a modifier on its own ("shift", "cmd") to press just that key.' },
      modifiers: { type: 'array', items: { type: 'string' }, description: 'Modifiers held while the key is pressed, such as ["cmd","shift"].' },
      repeat: { type: 'integer', description: 'Press the chord this many times (default 1).' },
      holdMs: { type: 'integer', description: 'How long to hold the key down, in milliseconds (default 15).' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          delivered: { type: 'boolean', required: true },
          key: { type: 'string', required: true },
          modifiers: { type: 'array', items: { type: 'string' }, required: true },
          repeat: { type: 'integer', required: true },
          reason: { type: 'string' },
        },
      },
      render: (_args, value) => {
        const chord = [...value.modifiers, value.key].join('+')
        if (!value.delivered) {
          return text(`The key press "${chord}" was not delivered${value.reason === undefined ? '' : `: ${value.reason}`}.`)
        }
        return text(`Pressed ${chord}${value.repeat > 1 ? ` x${String(value.repeat)}` : ''}.`)
      },
    },
    async execute(args, exec) {
      const modifiers = args.modifiers ?? []
      await requireWriteApproval({
        mode,
        ctx,
        exec,
        reason: `Computer Use wants to press ${[...modifiers, args.key].join('+')} on your desktop`
          + `${(args.repeat ?? 1) > 1 ? ` ${String(args.repeat)} times` : ''}.`,
      })
      const raw = await tools.engine.request<Record<string, unknown>>({
        method: 'keyboard',
        params: {
          action: 'key',
          key: args.key,
          modifiers,
          repeat: args.repeat ?? 1,
          ...args.holdMs === undefined ? {} : { holdMs: args.holdMs },
        },
        timeoutMs: 20_000,
        signal: exec.signal,
      })
      const reason = str(raw.reason)
      return {
        delivered: bool(raw.delivered),
        key: str(raw.key, args.key),
        modifiers: arr(raw.modifiers).map(entry => str(entry)),
        repeat: num(raw.repeat, args.repeat ?? 1),
        ...reason === '' ? {} : { reason },
      }
    },
  })
}

/** `cua_element`: act on an element directly, through its own accessibility actions. */
function elementTool(ctx: Context, tools: ToolContext, mode: WriteApprovalMode): ToolDefinition {
  return defineTool({
    name: 'cua_element',
    description: 'Act on one element from the most recent cua_tree by asking the application to perform the action itself, rather than synthesizing a click. '
      + 'This is the most reliable way to press a button, choose a menu item, focus a field, or write a text value: it needs no coordinates and cannot miss because a window moved. '
      + 'It also does not steal focus from whatever the user is doing. Prefer it over cua_click for anything with an accessibility surface. '
      + `Actions: ${copy.pressHelp}, setValue (replace a text field\'s contents), focus, scrollToVisible, menu (walk a menu path such as ["File","Export","PDF"]), list (report the element\'s available actions and attributes without changing anything). `
      + copy.treePermission,
    parameters: {
      element: { type: 'integer', required: true, description: 'Index from the most recent cua_tree dump.' },
      action: { type: 'string', enum: ['press', 'setValue', 'focus', 'scrollToVisible', 'menu', 'list'], description: 'What to do with the element (default press).' },
      text: { type: 'string', description: 'For action=setValue: the value to write into the element.' },
      path: { type: 'array', items: { type: 'string' }, description: 'For action=menu: menu titles from the menu bar inward, such as ["File","Export"] or ["File","Export","PDF…"].' },
      pid: { type: 'integer', description: 'Process id owning the element. Defaults to the application of the most recent cua_tree.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          performed: { type: 'boolean', required: true },
          action: { type: 'string', required: true },
          reason: { type: 'string' },
          screenX: { type: 'number' },
          screenY: { type: 'number' },
          path: { type: 'array', items: { type: 'string' } },
          actions: { type: 'array', items: { type: 'string' } },
          attributes: { type: 'array', items: { type: 'string' } },
        },
      },
      render: (_args, value) => {
        if (value.actions !== undefined) {
          return text(
            `Available actions: ${value.actions.length === 0 ? '(none)' : value.actions.join(', ')}.\n`
            + `${String((value.attributes ?? []).length)} readable attribute(s): ${(value.attributes ?? []).join(', ')}.`,
          )
        }
        if (value.action === 'click_fallback' && value.performed) {
          return text(`The element exposes no AXPress action, so it was clicked at its center (${String(value.screenX)}, ${String(value.screenY)}).`)
        }
        if (!value.performed) {
          return text(`The action "${value.action}" was not performed${value.reason === undefined ? '' : `: ${value.reason}`}. `
            + 'Re-read the tree with cua_tree and check that the index still refers to the element you meant.')
        }
        if (value.path !== undefined) {
          return text(`Invoked menu path: ${value.path.join(' → ')}.`)
        }
        return text(`Performed "${value.action}" on the element.`)
      },
    },
    async execute(args, exec) {
      if (args.action === 'list') {
        // Inspection changes nothing, so it is not a write and is not gated.
        const raw = await tools.engine.request<Record<string, unknown>>({
          method: 'element.action',
          params: {
            element: args.element,
            action: 'list',
            ...args.pid === undefined ? {} : { pid: args.pid },
          },
          timeoutMs: 15_000,
          signal: exec.signal,
        })
        return {
          performed: true,
          action: 'list',
          actions: arr(raw.actions).map(entry => str(entry)),
          attributes: arr(raw.attributes).map(entry => str(entry)),
        }
      }

      const action = args.action ?? 'press'
      if (action === 'setValue' && args.text === undefined) {
        throw new Error('action=setValue needs text')
      }
      if (action === 'menu' && (args.path ?? []).length === 0) {
        throw new Error('action=menu needs a non-empty path such as ["File","Export"]')
      }
      await requireWriteApproval({
        mode,
        ctx,
        exec,
        reason: action === 'menu'
          ? `Computer Use wants to invoke the menu path ${(args.path ?? []).join(' → ')} on your desktop.`
          : action === 'setValue'
            ? `Computer Use wants to replace the contents of element #${String(args.element)} with "${args.text ?? ''}".`
            : `Computer Use wants to perform "${action}" on element #${String(args.element)} on your desktop.`,
      })

      const raw = await tools.engine.request<Record<string, unknown>>({
        method: 'element.action',
        params: {
          element: args.element,
          action,
          ...args.text === undefined ? {} : { text: args.text },
          ...args.path === undefined ? {} : { path: args.path },
          ...args.pid === undefined ? {} : { pid: args.pid },
        },
        timeoutMs: 30_000,
        signal: exec.signal,
      })
      const reason = str(raw.reason)
      const path = arr(raw.path).map(entry => str(entry))
      return {
        performed: bool(raw.performed),
        action: str(raw.action, action),
        ...reason === '' ? {} : { reason },
        ...typeof raw.screenX === 'number' ? { screenX: num(raw.screenX) } : {},
        ...typeof raw.screenY === 'number' ? { screenY: num(raw.screenY) } : {},
        ...path.length === 0 ? {} : { path },
      }
    },
  })
}
