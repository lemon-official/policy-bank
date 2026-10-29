import type { ClientModule } from 'claude-code'

// One service in the bar, as the hooks module hands it over: plain data.
export type Chip = {
  id: string
  label: string
  ports: { port: number; isLan: boolean }[]
  note: string
  isChat: boolean
  // Cells the chip takes, estimated by the hooks module.
  width: number
}
export type StripProps = { chips: Chip[]; fancy: boolean }

type StripState = {
  offset: number
  // Where a drag started: the pointer's column and the offset then.
  drag?: { x: number; offset: number }
  // Whether the pointer moved since it went down, so letting go on a port
  // chip ends the drag instead of opening the page.
  hasDragged: boolean
}

// Cells kept at the right for the "‹N +N›" counters.
const COUNTER = 9

// The bar's services in one row that slides sideways: drag it, or click it and
// use ← → (Home, End). The counters say how many sit out of view on each side.
const BarStrip: ClientModule<StripProps, StripState> = (props, surface) => {
  const { Box, Text, Button } = surface.elements
  const state = surface.state ?? { offset: 0, hasDragged: false }
  const starts: number[] = []
  let total = 0
  for (const c of props.chips) {
    starts.push(total)
    total += c.width + 1
  }
  const view = Math.max(1, surface.columns - COUNTER)
  const max = Math.max(0, total - 1 - view)
  const clamp = (o: number) => Math.max(0, Math.min(max, o))
  const offset = clamp(state.offset)
  const left = starts.filter((s, i) => s + (props.chips[i]?.width ?? 0) <= offset).length
  const right = starts.filter(s => s >= offset + view).length
  const page = Math.max(4, Math.floor(view / 2))

  surface.onPointer(e => {
    const now = surface.state ?? state
    if (e.type === 'down' && e.button === 'left') {
      surface.setState({ ...now, drag: { x: e.x, offset }, hasDragged: false })
    } else if (e.type === 'move' && now.drag) {
      const next = clamp(now.drag.offset + now.drag.x - e.x)
      if (next !== now.offset || now.drag.x !== e.x) surface.setState({ ...now, offset: next, hasDragged: true })
    } else if (e.type === 'up' && now.drag) {
      surface.setState({ ...now, drag: undefined })
    }
  })
  surface.onKey(e => {
    const now = surface.state ?? state
    const by: Record<string, number> = { left: -page, right: page, home: -total, end: total }
    const step = by[e.key]
    if (step !== undefined) surface.setState({ ...now, offset: clamp(offset + step) })
  })
  const jump = (by: number) => surface.setState({ ...state, offset: clamp(offset + by), hasDragged: false })

  return (
    <Box flexDirection="row" width="100%">
      <Box flexGrow={1} flexShrink={1} overflow="hidden" flexDirection="row">
        <Box flexDirection="row" gap={1} flexShrink={0} marginLeft={-offset}>
          {props.chips.map(c => (
            <Box
              key={`chip:${c.id}`}
              flexDirection="row"
              alignItems="center"
              gap={1}
              flexShrink={0}
              borderStyle={props.fancy ? 'round' : undefined}
              borderColor={c.isChat ? 'success' : 'merged'}
              paddingX={props.fancy ? 1 : 0}
            >
              <Text weight="semibold">{c.label}</Text>
              {c.ports.map(p => (
                <Button
                  key={`port:${c.id}:${p.port}`}
                  plain
                  onPress={() => {
                    if (!(surface.state ?? state).hasDragged) surface.post({ open: p.port })
                  }}
                >
                  <Text color="inverseText" backgroundColor={p.isLan ? 'success' : 'suggestion'} weight="semibold" mono>
                    {` :${p.port} `}
                  </Text>
                </Button>
              ))}
              {c.note !== '' && (
                <Text dimColor size="caption">
                  {c.note}
                </Text>
              )}
            </Box>
          ))}
        </Box>
      </Box>
      <Box width={COUNTER} flexShrink={0} flexDirection="row" justifyContent="flex-end" alignItems="center" gap={1}>
        {left > 0 && (
          <Button key="strip:left" plain dimColor onPress={() => jump(-page)}>
            <Text dimColor>‹{left}</Text>
          </Button>
        )}
        {right > 0 && (
          <Button key="strip:right" plain onPress={() => jump(page)}>
            <Text color="suggestion" weight="semibold">
              +{right}›
            </Text>
          </Button>
        )}
      </Box>
    </Box>
  )
}

export default BarStrip
