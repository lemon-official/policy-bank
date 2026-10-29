import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderSurface } from 'claude-code'

import type { Here, Network, Origin, Server } from '../types'
import type { Chip, StripProps } from './bar-strip'

const PANE = 'running-servers'
const TITLE = 'Servers'
const REFRESH_MS = 10_000
// Cells kept free at each row's end for the shell, expose, restart and stop icons.
const ACTIONS_WIDTH = 10
// Marks this mod's LAN forwarders in `ps`, followed by the port they forward.
const EXPOSE_MARK = 'running-servers-expose'
// How long after a Bash call a server may start and still count as this chat's:
// a backgrounded `npm i && npm run dev` comes up well after the call returns.
const LAUNCH_SLACK_MS = 60_000
// The bar's icon for a known application, matched on its folder, name or container.
const APP_ICONS: [RegExp, string][] = [
  [/chatumcg/i, '⚕️'],
  [/vox/i, '🦊'],
  [/umcp|(^|[^a-z])mcp/i, '🦮'],
]

// Change the tag when a Server's fields change: it declines what an earlier
// version stored, which outlives a reload.
const servers = atom({ plugin: 'running-servers', key: 'servers' } as const, [], {
  shape: 'servers-3',
})
const filter = atom({ plugin: 'running-servers', key: 'filter' } as const, 'dev')
const scanning = atom({ plugin: 'running-servers', key: 'scanning' } as const, false)
const scannedAt = atom({ plugin: 'running-servers', key: 'scannedAt' } as const, 0)
const network = atom({ plugin: 'running-servers', key: 'network' } as const, {}, { shape: 'network-1' })
const expanded = atom({ plugin: 'running-servers', key: 'expanded' } as const, [])
const bar = atom({ plugin: 'running-servers', key: 'bar' } as const, true)
const here = atom({ plugin: 'running-servers', key: 'here' } as const, { cwd: '' }, { shape: 'here-1' })
const launches = atom({ plugin: 'running-servers', key: 'launches' } as const, [])

const ICON: Record<Origin, string> = {
  terminal: '🖥️',
  docker: '🐳',
  claude: '✳️',
  background: '⚙️',
  app: '📦',
}
const ORIGIN_LABEL: Record<Origin, string> = {
  terminal: 'Terminal',
  docker: 'Docker',
  claude: 'Claude Code',
  background: 'Detached / background',
  app: 'Apps & system',
}
const ORIGIN_ORDER: Origin[] = ['terminal', 'docker', 'claude', 'background', 'app']

// Ancestor executables that mean "started from this terminal", nearest first wins.
const TERMINALS: [RegExp, string][] = [
  [/\/Terminal\.app\//, 'Terminal'],
  [/iTerm/, 'iTerm2'],
  [/Ghostty/i, 'Ghostty'],
  [/WezTerm|wezterm-gui/, 'WezTerm'],
  [/\/Warp\.app\//, 'Warp'],
  [/\/kitty\.app\/|(^|\/)kitty$/, 'kitty'],
  [/Alacritty/i, 'Alacritty'],
  [/Visual Studio Code/, 'VS Code'],
  [/\/Cursor\.app\//, 'Cursor'],
  [/(^|\/)tmux$/, 'tmux'],
  [/(^|\/)zellij$/, 'zellij'],
]
// What `open -a` calls each terminal, for those AppleScript cannot pick a tab in.
const APP_NAME: Record<string, string> = {
  Ghostty: 'Ghostty',
  WezTerm: 'WezTerm',
  Warp: 'Warp',
  kitty: 'kitty',
  Alacritty: 'Alacritty',
  'VS Code': 'Visual Studio Code',
  Cursor: 'Cursor',
}
const CLAUDE = /(^|\/)claude$|\/Claude\.app\//
const SHELL = /(^|\/)-?(zsh|bash|sh|fish|nu|login)$/
const DOCKER_HELPER = /OrbStack|com\.docker|vpnkit|docker-proxy|limactl|colima|Rancher/i
const APP_PATH = /^\/(System|usr\/libexec|usr\/sbin|sbin)\/|\.app\/Contents\//

type Proc = { pid: number; ppid: number; age?: number; tty: string; comm: string; args: string }
type RunResult = { exitCode: number; stdout: string; stderr: string }

let paneOpen = false
let inFlight: Promise<void> | undefined

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'servers',
      description: 'Show the servers listening on this Mac in a pane',
    })
    await $.command.register({
      name: 'servers-bar',
      description: 'Turn the bar of this chat\'s servers above the prompt on or off',
    })
    paneOpen = true
    void $.ui.open({ id: PANE, title: TITLE })
    void scan($)
    $.clock.every(REFRESH_MS, async () => {
      if (paneOpen || (await read($, bar))) void scan($)
    })

    return next(e)
  })

  on('command.run', { command: 'servers' }, async $ => {
    paneOpen = true
    await $.ui.open({ id: PANE, title: TITLE, focus: true })
    void scan($)

    return { text: 'Servers pane opened.' }
  })

  on('command.run', { command: 'servers-bar' }, async $ => {
    const isOn = await update($, bar, v => !v)
    if (isOn) void scan($)

    return { text: isOn ? 'Servers bar on.' : 'Servers bar off.' }
  })

  // Every Bash call opens a window in which a server that starts counts as this
  // chat's; the bar matches start times against them.
  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const from = await $.clock.now()
    const ran = await next(e)
    if (ran.deny === undefined) {
      const to = (await $.clock.now()) + LAUNCH_SLACK_MS
      await update($, launches, ws => [...ws, { from: from - 2_000, to }].slice(-200))
      if (await read($, bar)) rescanSoon($)
    }

    return ran
  })

  on('ui.close', { id: PANE }, ($, e, next) => {
    paneOpen = false

    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const table = $.ui.resolve(e)
    const { Box, Text, Button } = table
    const Select = 'Select' in table ? table.Select : undefined
    const list = await read($, servers)
    const picked = await read($, filter)
    const busy = await read($, scanning)
    const now = await read($, scannedAt)
    const net = await read($, network)
    const unfolded = new Set(await read($, expanded))
    // The age goes transparent under the hover icons too, where a surface draws raw colors.
    const hideOnHover = e.surface === 'terminal' ? undefined : { color: 'transparent' }
    const toggle = (id: string) =>
      void update($, expanded, ids => (ids.includes(id) ? ids.filter(i => i !== id) : [...ids, id]))

    const counts = new Map<Origin, number>()
    for (const s of list) counts.set(s.origin, (counts.get(s.origin) ?? 0) + 1)
    const devCount = list.filter(s => s.origin !== 'app').length
    const options = [
      { value: 'dev', label: `All dev servers (${devCount})` },
      ...ORIGIN_ORDER.filter(o => counts.has(o)).map(o => ({
        value: o,
        label: `${ICON[o]} ${ORIGIN_LABEL[o]} (${counts.get(o)})`,
      })),
      { value: 'all', label: `Everything (${list.length})` },
    ]
    const value = options.some(o => o.value === picked) ? picked : 'dev'
    const shown = list.filter(s =>
      value === 'all' ? true : value === 'dev' ? s.origin !== 'app' : s.origin === value,
    )
    const setFilter = (v: string) => void update($, filter, () => v)
    // `shown` is newest first, so each group lands where its newest service is;
    // services with no folder go last.
    const groups = new Map<string, Server[]>()
    for (const s of shown) groups.set(s.group, [...(groups.get(s.group) ?? []), s])
    const ordered = [...groups].sort(([a], [b]) => Number(a === '') - Number(b === ''))

    const lanCount = shown.filter(s => (s.lan?.length ?? 0) > 0).length

    return (
      <Box flexDirection="column" gap="sm">
        <Box flexDirection="row" justifyContent="space-between" alignItems="center" flexWrap="wrap" gap={1}>
          <Text size="heading" weight="bold">
            Servers
          </Text>
          <Text>
            <Text color="success">●</Text> <Text weight="semibold">{shown.length}</Text>
            <Text dimColor> running</Text>
            {lanCount > 0 && (
              <Text>
                <Text dimColor> · </Text>
                <Text color="success">🌐 {lanCount}</Text>
                <Text dimColor> on LAN</Text>
              </Text>
            )}
            {net.tailscaleName && <Text color="merged"> · ◆ tailscale</Text>}
          </Text>
        </Box>
        <Box flexDirection="row" gap={1} alignItems="center" flexWrap="wrap">
          {Select ? (
            <Select key="filter" label="Started from" options={options} value={value} onSelect={setFilter} />
          ) : (
            options.map(o => (
              <Button key={`filter:${o.value}`} plain dimColor={o.value !== value} onPress={() => setFilter(o.value)} label={o.label} />
            ))
          )}
          <Button key="refresh" plain dimColor onPress={() => void scan($)}>
            <Text color="suggestion">{busy ? '↻ scanning…' : '↻ refresh'}</Text>
          </Button>
        </Box>
        {shown.length === 0 && (
          <Box borderStyle="round" borderColor="subtle" paddingX={1} justifyContent="center">
            <Text dimColor italic>
              {busy ? 'Scanning ports…' : 'Nothing listening here.'}
            </Text>
          </Box>
        )}
        {ordered.map(([group, rows]) => (
          <Box key={`group:${group}`} flexDirection="column" borderStyle="round" borderColor="subtle" paddingX={1} gap="xs">
            <Box flexDirection="row" justifyContent="space-between">
              <Text weight="semibold" color="claude">
                📁 {group ? tilde(group) : 'No folder'}
              </Text>
              <Text dimColor>{rows.length === 1 ? '1 service' : `${rows.length} services`}</Text>
            </Box>
            {worktrees(rows).map(([tree, members]) => (
              <Box key={`tree:${group}:${tree}`} flexDirection="column" paddingLeft={2} gap="xs">
                {tree && (
                  <Text>
                    <Text weight="semibold">⎇ {basename(tree)}</Text>
                    {members[0]?.branch ? (
                      <Text>
                        {'  '}
                        <Text color="merged" italic>
                          {members[0].branch}
                        </Text>
                      </Text>
                    ) : (
                      ''
                    )}
                  </Text>
                )}
                {members.map(s => {
                  const onLan = (s.lan?.length ?? 0) > 0
                  const when = age(now, s.startedAt)
                  const open = unfolded.has(s.id)
                  // The always-shown network icon: copies the address, or stops this mod's forwarder.
                  const lanButton = (key: string) => (
                    <Button key={key} plain onPress={() => void (s.forwards?.length ? unexpose($, s) : copyUrl($, e.surface, addresses(net, s.lan?.[0] ?? 0)[0] ?? ''))}>
                      <Text color="success" weight="bold">
                        ⇄
                      </Text>
                    </Button>
                  )

                  return (
                    <Box key={s.id} flexDirection="row" width="100%" justifyContent="space-between">
                      <Box flexDirection="column" flexGrow={1} flexShrink={1} minWidth={0}>
                        <Box flexDirection="row" gap={1} flexWrap="wrap" alignItems="center">
                          <Button key={`${s.id}:more`} plain onPress={() => toggle(s.id)}>
                            <Text>
                              <Text dimColor>{open ? '▾' : '▸'}</Text> {ICON[s.origin]} <Text weight="bold">{s.name}</Text>
                            </Text>
                          </Button>
                          {s.ports.map(p => (
                            <Button key={`${s.id}:port:${p}`} plain onPress={() => void openUrl($, p)}>
                              <Text color="inverseText" backgroundColor={onLan && s.lan?.includes(p) ? 'success' : 'suggestion'} weight="semibold" mono>
                                {` :${p} ↗ `}
                              </Text>
                            </Button>
                          ))}
                        </Box>
                        {open && (
                          <Box flexDirection="column" paddingLeft={2}>
                            <Text dimColor size="footnote">
                              {[s.container ?? (s.command ? shortCommand(s.command) : undefined), s.where].filter(Boolean).join('  ·  ')}
                            </Text>
                            {onLan && (
                              <Box flexDirection="row" gap={1} flexWrap="wrap">
                                {(s.lan ?? []).flatMap(p =>
                                  addresses(net, p).map(a => (
                                    <Button key={`${s.id}:addr:${a}`} plain dimColor onPress={() => void copyUrl($, e.surface, a)}>
                                      <Text color={a.startsWith(net.tailscaleName ?? '\0') ? 'merged' : 'success'} size="footnote" mono>
                                        {a.startsWith(net.tailscaleName ?? '\0') ? '◆ ' : '🌐 '}
                                        {a}
                                      </Text>
                                    </Button>
                                  )),
                                )}
                              </Box>
                            )}
                          </Box>
                        )}
                      </Box>
                      {/* A fixed slot at the right edge: the age, with the network icon
                          beside it while the service is on the LAN. Hovering the row covers
                          it with the action icons: a hover can only reveal, so they sit in a
                          placed Box across the whole slot, filled with the background
                          (inverseText) so nothing shows through. No `label`: the desktop
                          draws it in place of the icon. */}
                      <Box width={ACTIONS_WIDTH} flexShrink={0} flexDirection="row" justifyContent="flex-end" gap={1}>
                        {onLan && lanButton(`${s.id}:lan`)}
                        <Text size="caption" color={freshness(now, s.startedAt)} dimColor={freshness(now, s.startedAt) === undefined} hover={hideOnHover}>
                          {when ?? ''}
                        </Text>
                        <Box
                          position="absolute"
                          top={0}
                          left={0}
                          right={0}
                          flexDirection="row"
                          justifyContent="flex-end"
                          gap={1}
                          backgroundColor="inverseText"
                          display="none"
                          hover={{ display: 'flex' }}
                        >
                          {onLan && lanButton(`${s.id}:lan-hover`)}
                          {!onLan && canExpose(s, net) && (
                            <Button key={`${s.id}:expose`} plain dimColor onPress={() => void expose($, s, net)}>
                              <Text color="success">⇄</Text>
                            </Button>
                          )}
                          {canShell(s) && (
                            <Button key={`${s.id}:shell`} plain dimColor onPress={() => void shell($, s)}>
                              <Text color="suggestion">{'>_'}</Text>
                            </Button>
                          )}
                          {canRestart(s) && (
                            <Button key={`${s.id}:restart`} plain dimColor onPress={() => void restart($, s)}>
                              <Text color="warning">↻</Text>
                            </Button>
                          )}
                          {canStop(s) && (
                            <Button key={`${s.id}:stop`} plain dimColor onPress={() => void stop($, s)}>
                              <Text color="error">■</Text>
                            </Button>
                          )}
                        </Box>
                      </Box>
                    </Box>
                  )
                })}
              </Box>
            ))}
          </Box>
        ))}
      </Box>
    )
  })

  // The bar above the prompt: the services this chat started, then those of its
  // worktree or branch, in a strip that slides sideways (./bar-strip.tsx).
  // Nothing to show, it leaves the band to others.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey || !(await read($, bar))) return next(e)
    const table = $.ui.resolve(e)
    if (!('Client' in table)) return next(e)
    const { Box, Text, Button, Client } = table
    const list = await read($, servers)
    const where = await read($, here)
    const ws = await read($, launches)
    const now = await read($, scannedAt)
    const fancy = e.surface !== 'terminal'
    const chips = list
      .flatMap(s => {
        const why = relation(s, where, ws)

        return why ? [{ s, why }] : []
      })
      .sort((a, b) => Number(b.why === 'chat') - Number(a.why === 'chat'))
      .map(({ s, why }): Chip => {
        const tag = why === 'branch' ? `⎇ ${s.branch}` : why === 'worktree' ? '⎇ worktree' : why === 'folder' ? '📁 folder' : undefined
        const note = [tag, age(now, s.startedAt)].filter(Boolean).join(' · ')
        const label = `${appIcon(s)} ${s.name}`
        // An emoji takes two cells; a port chip is " :port " and a gap.
        const width = (fancy ? 4 : 0) + label.length + 1 + s.ports.reduce((n, p) => n + String(p).length + 4, 0) + (note ? note.length + 1 : 0)

        return { id: s.id, label, ports: s.ports.map(port => ({ port, isLan: s.lan?.includes(port) ?? false })), note, isChat: why === 'chat', width }
      })
    if (chips.length === 0) return next(e)
    const strip: StripProps = { chips, fancy }

    return (
      <Box flexDirection="row" alignItems="center" gap={1}>
        <Client key="bar:strip" module="./bar-strip.tsx" props={strip} flexGrow={1} />
        <Button
          key="bar:pane"
          plain
          dimColor
          onPress={() => {
            paneOpen = true
            void $.ui.open({ id: PANE, title: TITLE, focus: true })
          }}
        >
          <Text color="suggestion">⧉</Text>
        </Button>
        <Button
          key="bar:hide"
          plain
          dimColor
          onPress={() => {
            void update($, bar, () => false)
            $.ui.toast('Servers bar off: /servers-bar brings it back')
          }}
        >
          <Text dimColor>✕</Text>
        </Button>
      </Box>
    )
  })

  // A port chip pressed in the strip.
  on('ui.message', { element: 'bar:strip' }, async ($, e, next) => {
    const data = e.data as { open?: unknown } | null
    if (typeof data?.open === 'number') await openUrl($, data.open)

    return next(e)
  })
}

// --- scanning -------------------------------------------------------------

async function scan($: EngineInterface): Promise<void> {
  if (inFlight) return inFlight
  inFlight = (async () => {
    await update($, scanning, () => true)
    try {
      const [list, at] = await Promise.all([collect($), readHere($)])
      await update($, servers, () => list)
      await update($, here, () => at)
    } finally {
      await update($, scanning, () => false)
      inFlight = undefined
    }
  })()

  return inFlight
}

async function collect($: EngineInterface): Promise<Server[]> {
  const [lsof, psMeta, psArgs, docker, net] = await Promise.all([
    run($, ['lsof', '-nP', '-iTCP', '-sTCP:LISTEN', '-F', 'pcn']),
    run($, ['ps', '-axww', '-o', 'pid=,ppid=,etime=,tty=,comm=']),
    run($, ['ps', '-axww', '-o', 'pid=,args=']),
    run($, ['docker', 'ps', '--format', '{{json .}}']),
    readNetwork($),
  ])
  await update($, network, () => net)
  const procs = parsePs(psMeta.stdout, psArgs.stdout)
  const listeners = parseLsof(lsof.stdout)
  const containers = docker.exitCode === 0 ? parseDocker(docker.stdout) : []
  const dockerPorts = new Set(containers.flatMap(c => c.ports))
  const forwarders = new Map<number, number>()
  for (const p of procs.values()) {
    const port = forwardedPort(p.args)
    if (port) forwarders.set(port, p.pid)
  }

  const byRoot = new Map<number, Server>()
  for (const [pid, bound] of listeners) {
    const self = procs.get(pid)
    if (!self || forwardedPort(self.args)) continue
    let ports = bound.ports
    if (DOCKER_HELPER.test(self.comm)) {
      ports = ports.filter(p => !dockerPorts.has(p))
      if (ports.length === 0) continue
    }
    const s = classify(self, procs, ports)
    s.lan = bound.lan.filter(p => ports.includes(p))
    const key = s.rootPid ?? pid
    const seen = byRoot.get(key)
    if (seen) {
      seen.ports = union(seen.ports, ports)
      seen.lan = union(seen.lan ?? [], s.lan)
    } else byRoot.set(key, s)
  }

  const now = await $.clock.now()
  const local = [...byRoot.values()]
  for (const s of local) {
    const age = procs.get(s.rootPid ?? s.pid ?? 0)?.age
    if (age !== undefined) s.startedAt = now - age * 1000
  }
  const roots = local.map(s => s.rootPid).filter((p): p is number => p !== undefined)
  if (roots.length > 0) {
    const cwds = parseCwd((await run($, ['lsof', '-a', '-d', 'cwd', '-p', roots.join(','), '-Fpn'])).stdout)
    for (const s of local) if (s.rootPid && s.origin !== 'app') s.cwd = cwds.get(s.rootPid)
  }

  const dockers = containers.map(c => c.server)
  if (dockers.length > 0) {
    const started = await run($, ['docker', 'inspect', '-f', '{{.Name}}|{{.State.StartedAt}}', ...dockers.map(s => s.container!)])
    for (const line of started.stdout.split('\n')) {
      const [name = '', at = ''] = line.replace(/^\//, '').split('|')
      const s = dockers.find(d => d.container === name)
      if (s && Date.parse(at)) s.startedAt = Date.parse(at)
    }
  }

  const all = [...dockers, ...local]
  for (const s of all) {
    s.forwards = s.ports.flatMap(port => {
      const pid = forwarders.get(port)

      return pid ? [{ port, pid }] : []
    })
    s.lan = union(s.lan ?? [], s.forwards.map(f => f.port))
  }
  await nameByGit($, all)
  await update($, scannedAt, () => now)

  return all.sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0))
}

// Names each service after its subfolder in its git worktree, notes the
// worktree and branch, and groups worktrees under their main repository's path.
async function nameByGit($: EngineInterface, list: Server[]): Promise<void> {
  const dirs = [...new Set(list.map(s => s.cwd).filter((d): d is string => !!d))]
  const info = new Map<string, { top: string; branch: string; main: string }>()
  await Promise.all(
    dirs.map(async dir => {
      const r = await run($, ['git', '-C', dir, 'rev-parse', '--show-toplevel', '--abbrev-ref', 'HEAD', '--path-format=absolute', '--git-common-dir'])
      const [top = '', branch = '', common = ''] = r.stdout.trim().split('\n')
      if (r.exitCode === 0 && top) info.set(dir, { top, branch, main: common.replace(/\/\.git\/?$/, '') })
    }),
  )
  for (const s of list) {
    if (!s.cwd) continue
    const git = info.get(s.cwd)
    if (!git) {
      s.group = s.cwd
      s.name = basename(s.cwd)
      continue
    }
    const sub = s.cwd.startsWith(`${git.top}/`) ? s.cwd.slice(git.top.length + 1) : ''
    s.group = git.main
    s.worktree = git.top
    s.name = sub || basename(git.top)
    s.branch = git.branch === 'HEAD' ? 'detached' : git.branch
  }
}

async function readHere($: EngineInterface): Promise<Here> {
  const cwd = await $.session.cwd()
  const r = await run($, ['git', '-C', cwd, 'rev-parse', '--show-toplevel', '--abbrev-ref', 'HEAD'])
  const [worktree = '', branch = ''] = r.stdout.trim().split('\n')
  if (r.exitCode !== 0 || !worktree) return { cwd }

  return { cwd, worktree, branch: branch === 'HEAD' ? undefined : branch }
}

// Why the bar shows a service: this chat started it (a Claude-run or detached
// process, or a container, that started inside a Bash call's window), or it runs
// in the session's worktree, on its branch, or under its folder (outside git;
// not for a folder as wide as the home folder).
function relation(s: Server, at: Here, ws: { from: number; to: number }[]): 'chat' | 'worktree' | 'branch' | 'folder' | undefined {
  const t = s.startedAt
  const byChat = s.origin === 'claude' || s.origin === 'background' || s.origin === 'docker'
  if (byChat && t !== undefined && ws.some(w => t >= w.from && t <= w.to)) return 'chat'
  if (at.worktree && s.worktree === at.worktree) return 'worktree'
  if (at.branch && s.branch === at.branch) return 'branch'
  const deep = at.cwd.split('/').length > 3
  if (!at.worktree && deep && s.cwd && (s.cwd === at.cwd || s.cwd.startsWith(`${at.cwd}/`))) return 'folder'

  return undefined
}

// A known application's icon in the bar, else where the service was started.
function appIcon(s: Server): string {
  const names = [s.group, s.worktree, s.name, s.container].filter(Boolean).map(n => basename(n ?? ''))
  const hit = APP_ICONS.find(([re]) => names.some(n => re.test(n)))

  return hit?.[1] ?? ICON[s.origin]
}

function basename(path: string): string {
  return path.replace(/\/+$/, '').split('/').pop() || path
}

export function classify(self: Proc, procs: Map<number, Proc>, ports: number[]): Server {
  const base = { ports: [...ports].sort((a, b) => a - b), pid: self.pid }
  if (APP_PATH.test(self.comm) || DOCKER_HELPER.test(self.comm)) {
    const name = appName(self.comm)

    return { ...base, id: `pid:${self.pid}`, origin: 'app', name, where: name, group: '' }
  }

  // The service's root: climb while the parent is still part of it, stopping
  // at a shell, a terminal, Claude, an app or launchd.
  let root = self
  for (let p = procs.get(root.ppid); p && p.pid !== 1 && !isLauncher(p.comm); p = procs.get(p.ppid)) root = p

  let origin: Origin = 'background'
  let terminalApp: string | undefined
  for (let p = procs.get(self.ppid); p && p.pid !== 1; p = procs.get(p.ppid)) {
    if (CLAUDE.test(p.comm)) {
      origin = 'claude'
      break
    }
    const term = TERMINALS.find(([re]) => re.test(p.comm))
    if (term) {
      origin = 'terminal'
      terminalApp = term[1]
      break
    }
  }
  const tty = ttyPath(root.tty) ?? ttyPath(self.tty)
  const where =
    origin === 'terminal'
      ? `${terminalApp}${tty ? ` · ${tty.replace('/dev/', '')}` : ''}`
      : origin === 'claude'
        ? 'Claude Code'
        : 'Detached (no terminal)'

  return {
    ...base,
    id: `pid:${root.pid}`,
    origin,
    name: shortCommand(root.args),
    group: '',
    where,
    rootPid: root.pid,
    command: root.args,
    terminalApp,
    tty,
  }
}

function isLauncher(comm: string): boolean {
  return SHELL.test(comm) || CLAUDE.test(comm) || APP_PATH.test(comm) || TERMINALS.some(([re]) => re.test(comm))
}

export function parsePs(meta: string, args: string): Map<number, Proc> {
  const procs = new Map<number, Proc>()
  for (const line of meta.split('\n')) {
    const [, pid = '', ppid = '', etime = '', tty = '', comm = ''] = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(\S+)\s+(.*)$/.exec(line) ?? []
    if (pid) procs.set(Number(pid), { pid: Number(pid), ppid: Number(ppid), age: parseEtime(etime), tty, comm: comm.trim(), args: comm.trim() })
  }
  for (const line of args.split('\n')) {
    const [, pid = '', rest = ''] = /^\s*(\d+)\s+(.*)$/.exec(line) ?? []
    const p = procs.get(Number(pid))
    if (p) p.args = rest.trim()
  }

  return procs
}

// ps's elapsed time, `[[dd-]hh:]mm:ss`, in seconds.
function parseEtime(etime: string): number | undefined {
  const m = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/.exec(etime)
  if (!m) return undefined
  const [, d = '0', h = '0', min = '0', s = '0'] = m

  return ((Number(d) * 24 + Number(h)) * 60 + Number(min)) * 60 + Number(s)
}

// Each listening pid's ports, and which of them are bound beyond loopback.
export function parseLsof(text: string): Map<number, { ports: number[]; lan: number[] }> {
  const out = new Map<number, { ports: number[]; lan: number[] }>()
  let pid = 0
  for (const line of text.split('\n')) {
    if (line.startsWith('p')) pid = Number(line.slice(1))
    else if (line.startsWith('n') && pid) {
      const at = line.lastIndexOf(':')
      const port = Number(line.slice(at + 1))
      if (!port) continue
      const bound = out.get(pid) ?? { ports: [], lan: [] }
      bound.ports = union(bound.ports, [port])
      if (!isLoopback(line.slice(1, at))) bound.lan = union(bound.lan, [port])
      out.set(pid, bound)
    }
  }

  return out
}

function isLoopback(host: string): boolean {
  return /^(127\.|\[::1\]$|::1$|localhost$)/.test(host)
}

function union(a: number[], b: number[]): number[] {
  return [...new Set([...a, ...b])].sort((x, y) => x - y)
}

function forwardedPort(args: string): number | undefined {
  const m = new RegExp(`${EXPOSE_MARK} (\\d+)`).exec(args)

  return m ? Number(m[1]) : undefined
}

async function readNetwork($: EngineInterface): Promise<Network> {
  const [en0, en1, host, ts] = await Promise.all([
    run($, ['ipconfig', 'getifaddr', 'en0']),
    run($, ['ipconfig', 'getifaddr', 'en1']),
    run($, ['scutil', '--get', 'LocalHostName']),
    run($, ['tailscale', 'status', '--json'], { timeoutMs: 5000 }).then(r =>
      r.exitCode === 127 ? run($, ['/Applications/Tailscale.app/Contents/MacOS/Tailscale', 'status', '--json'], { timeoutMs: 5000 }) : r,
    ),
  ])
  const net: Network = {
    lanIp: en0.stdout.trim() || en1.stdout.trim() || undefined,
    host: host.stdout.trim() ? `${host.stdout.trim()}.local` : undefined,
  }
  try {
    const status = JSON.parse(ts.stdout) as { BackendState?: string; Self?: { DNSName?: string; TailscaleIPs?: string[] } }
    if (status.BackendState === 'Running') {
      net.tailscaleName = status.Self?.DNSName?.replace(/\.$/, '') || undefined
      net.tailscaleIp = status.Self?.TailscaleIPs?.find(ip => ip.includes('.'))
    }
  } catch {
    // Tailscale not installed or not answering.
  }

  return net
}

function parseCwd(text: string): Map<number, string> {
  const out = new Map<number, string>()
  let pid = 0
  for (const line of text.split('\n')) {
    if (line.startsWith('p')) pid = Number(line.slice(1))
    else if (line.startsWith('n') && pid) out.set(pid, line.slice(1))
  }

  return out
}

export function parseDocker(text: string): { ports: number[]; server: Server }[] {
  const out: { ports: number[]; server: Server }[] = []
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    let c: Record<string, string | undefined>
    try {
      c = JSON.parse(line)
    } catch {
      continue
    }
    const published = [...(c.Ports ?? '').matchAll(/(?:^|,\s*)([^,]*?):(\d+)->/g)]
    const ports = union([], published.map(m => Number(m[2])))
    const lan = union([], published.filter(m => !isLoopback(m[1] ?? '')).map(m => Number(m[2])))
    const project = /com\.docker\.compose\.project=([^,]+)/.exec(c.Labels ?? '')?.[1]
    const dir = /com\.docker\.compose\.project\.working_dir=([^,]+)/.exec(c.Labels ?? '')?.[1]
    const name = c.Names ?? c.ID ?? '?'
    out.push({
      ports,
      server: {
        id: `docker:${name}`,
        origin: 'docker',
        name,
        ports,
        lan,
        group: '',
        where: project ? `Docker · compose ${project}` : `Docker · ${c.Image}`,
        cwd: dir,
        container: name,
      },
    })
  }

  return out
}

function ttyPath(tty: string): string | undefined {
  if (!tty || tty.startsWith('?')) return undefined

  return tty.startsWith('tty') ? `/dev/${tty}` : `/dev/tty${tty}`
}

function appName(comm: string): string {
  return /([^/]+)\.app\//.exec(comm)?.[1] ?? comm.split('/').pop() ?? comm
}

function shortCommand(args: string): string {
  const s = args
    .split(/\s+/)
    .map(t => (t.includes('/') && !t.includes('=') ? t.split('/').pop() || t : t))
    .join(' ')

  return s.length > 70 ? `${s.slice(0, 69)}…` : s
}

// A group's services by worktree, newest first as they came; those outside
// git ('') lead, as they belong to the path itself.
function worktrees(rows: Server[]): [string, Server[]][] {
  const trees = new Map<string, Server[]>()
  for (const s of rows) trees.set(s.worktree ?? '', [...(trees.get(s.worktree ?? '') ?? []), s])

  return [...trees].sort(([a], [b]) => Number(a !== '') - Number(b !== ''))
}

// Green while under an hour old, plain under a day, dim after.
function freshness(now: number, startedAt?: number): 'success' | 'text' | undefined {
  if (!now || !startedAt) return undefined
  const ms = now - startedAt

  return ms < 3_600_000 ? 'success' : ms < 86_400_000 ? 'text' : undefined
}

function age(now: number, startedAt?: number): string | undefined {
  if (!now || !startedAt) return undefined
  const s = Math.max(0, Math.round((now - startedAt) / 1000))
  if (s < 60) return 'just now'
  const [n, unit] = s < 3600 ? [s / 60, 'm'] : s < 86_400 ? [s / 3600, 'h'] : [s / 86_400, 'd']

  return `${Math.floor(n)}${unit} ago`
}

function tilde(path: string): string {
  return path.replace(/^\/Users\/[^/]+/, '~')
}

// --- actions --------------------------------------------------------------

const scriptable = (s: Server) => (s.terminalApp === 'Terminal' || s.terminalApp === 'iTerm2') && !!s.tty

function canShell(s: Server): boolean {
  if (s.origin === 'docker') return true
  if (s.origin === 'terminal') return scriptable(s) || !!(s.terminalApp && APP_NAME[s.terminalApp])
  return (s.origin === 'claude' || s.origin === 'background') && !!s.cwd
}

function canRestart(s: Server): boolean {
  if (s.origin === 'docker') return true
  if (s.origin === 'terminal') return scriptable(s) && !!s.command
  return (s.origin === 'claude' || s.origin === 'background') && !!s.cwd && !!s.command
}

function canStop(s: Server): boolean {
  return s.origin === 'docker' || (s.origin !== 'app' && s.rootPid !== undefined)
}

function canExpose(s: Server, net: Network): boolean {
  return (!!net.lanIp || !!net.tailscaleIp) && s.ports.some(p => !s.lan?.includes(p))
}

// Where a LAN port is reached from another machine: IP, Bonjour name, and the
// Tailscale name while connected.
function addresses(net: Network, port: number): string[] {
  return [net.lanIp, net.host, net.tailscaleName].filter((h): h is string => !!h).map(h => `${h}:${port}`)
}

async function copyUrl($: EngineInterface, surface: RenderSurface, address: string): Promise<void> {
  const r = await $.ui.copy({ text: `http://${address}`, surface })
  $.ui.toast(r.isCopied ? `Copied http://${address}` : `http://${address}`)
}

// A small TCP forwarder (python3 ships with macOS) listening on the same port
// at the LAN and Tailscale addresses, passing each connection to loopback.
// A different local address, so it never clashes with the server's own bind.
const FORWARDER = `import asyncio, sys
port = int(sys.argv[2])
hosts = sys.argv[3:]
async def pipe(r, w):
    try:
        while True:
            d = await r.read(65536)
            if not d:
                break
            w.write(d)
            await w.drain()
    except Exception:
        pass
    finally:
        try:
            w.close()
        except Exception:
            pass
async def handle(cr, cw):
    for h in ('127.0.0.1', '::1'):
        try:
            ur, uw = await asyncio.open_connection(h, port)
            break
        except OSError:
            continue
    else:
        cw.close()
        return
    await asyncio.gather(pipe(cr, uw), pipe(ur, cw))
async def main():
    servers = []
    for h in hosts:
        try:
            servers.append(await asyncio.start_server(handle, h, port))
        except OSError as e:
            print('skip', h, e, flush=True)
    if not servers:
        sys.exit(1)
    await asyncio.gather(*(s.serve_forever() for s in servers))
asyncio.run(main())
`

async function expose($: EngineInterface, s: Server, net: Network): Promise<void> {
  const hosts = [net.lanIp, net.tailscaleIp].filter((h): h is string => !!h)
  const ports = s.ports.filter(p => !s.lan?.includes(p))
  if (hosts.length === 0 || ports.length === 0) return
  // One line, so `ps` shows the mark and port on the forwarder's own row.
  const code = `exec(${JSON.stringify(FORWARDER)})`
  for (const port of ports) {
    const r = await run($, [
      '/bin/sh',
      '-c',
      `code=$1; shift; nohup /usr/bin/python3 -c "$code" ${EXPOSE_MARK} "$@" </dev/null >"/tmp/${EXPOSE_MARK}-$1.log" 2>&1 &`,
      'sh',
      code,
      String(port),
      ...hosts,
    ])
    if (r.exitCode !== 0) return report($, r)
  }
  $.ui.toast(`Exposing :${ports.join(', :')} on ${hosts.join(' and ')}`)
  rescanSoon($)
}

async function unexpose($: EngineInterface, s: Server): Promise<void> {
  const pids = (s.forwards ?? []).map(f => String(f.pid))
  if (pids.length === 0) return
  await report($, await run($, ['kill', ...pids]), undefined, `Stopped exposing ${s.name} on LAN.`)
  rescanSoon($)
}

async function shell($: EngineInterface, s: Server): Promise<void> {
  if (s.container) {
    return report($, await openInTerminal($, `docker exec -it ${s.container} sh -c 'command -v bash >/dev/null && exec bash || exec sh'`))
  }
  if (s.origin === 'terminal' && s.tty && scriptable(s)) {
    const r = await focusTab($, s.terminalApp!, s.tty)
    return report($, r, r.stdout.trim() === 'missing' ? `That ${s.terminalApp} tab is gone.` : undefined)
  }
  const app = s.terminalApp && APP_NAME[s.terminalApp]
  if (s.origin === 'terminal' && app) return report($, await run($, ['open', '-a', app]))
  if (s.cwd) return report($, await openInTerminal($, `cd ${quote(s.cwd)}`))
}

async function restart($: EngineInterface, s: Server): Promise<void> {
  if (s.container) {
    $.ui.toast(`Restarting ${s.container}…`)
    await report($, await run($, ['docker', 'restart', s.container], { timeoutMs: 120_000 }), undefined, `Restarted ${s.container}.`)
    return rescanSoon($)
  }
  if (!s.rootPid || !s.command || !(await stillSame($, s))) return

  if (s.origin === 'terminal' && s.tty) {
    // Ctrl-C the job, then type its command again in the same tab.
    await killTree($, s.rootPid, 'INT')
    const r = await focusTab($, s.terminalApp!, s.tty, s.command)
    await report($, r, r.stdout.trim() === 'missing' ? `Stopped, but that ${s.terminalApp} tab is gone.` : undefined, `Restarted in ${s.terminalApp}.`)
    return rescanSoon($)
  }
  if (!s.cwd) return
  await killTree($, s.rootPid, 'TERM')
  const log = `/tmp/running-servers-${s.ports[0] ?? s.rootPid}.log`
  const r = await run($, [
    '/bin/sh',
    '-c',
    'cd "$1" || exit 1; nohup /bin/zsh -lc "$2" </dev/null >"$3" 2>&1 &',
    'sh',
    s.cwd,
    s.command,
    log,
  ])
  await report($, r, undefined, `Restarted ${s.name}; output in ${log}`)
  return rescanSoon($)
}

async function stop($: EngineInterface, s: Server): Promise<void> {
  if (s.container) {
    await report($, await run($, ['docker', 'stop', s.container], { timeoutMs: 60_000 }), undefined, `Stopped ${s.container}.`)
    return rescanSoon($)
  }
  if (!s.rootPid || !(await stillSame($, s))) return
  await killTree($, s.rootPid, s.origin === 'terminal' ? 'INT' : 'TERM')
  $.ui.toast(`Stopped ${s.name}.`)
  return rescanSoon($)
}

// The pid could have been reused since the scan: act only on the same command.
async function stillSame($: EngineInterface, s: Server): Promise<boolean> {
  const r = await run($, ['ps', '-ww', '-o', 'args=', '-p', String(s.rootPid)])
  if (r.stdout.trim() === s.command) return true
  $.ui.toast(`${s.name} is no longer running as scanned; refreshing.`)
  void scan($)

  return false
}

async function killTree($: EngineInterface, rootPid: number, signal: 'INT' | 'TERM'): Promise<void> {
  const ps = await run($, ['ps', '-ax', '-o', 'pid=,ppid='])
  const children = new Map<number, number[]>()
  for (const line of ps.stdout.split('\n')) {
    const [pid = 0, ppid = 0] = line.trim().split(/\s+/).map(Number)
    if (pid) children.set(ppid, [...(children.get(ppid) ?? []), pid])
  }
  const tree: number[] = []
  for (const queue = [rootPid]; queue.length > 0; ) {
    const pid = queue.shift()!
    tree.push(pid)
    queue.push(...(children.get(pid) ?? []))
  }
  // Signal, wait up to ~6 s for the root to exit, then KILL what is left.
  await run(
    $,
    [
      '/bin/sh',
      '-c',
      'sig=$1; root=$2; shift 2; kill -$sig "$@" 2>/dev/null; i=0; ' +
        'while [ $i -lt 30 ] && kill -0 $root 2>/dev/null; do sleep 0.2; i=$((i+1)); done; ' +
        'for p in "$@"; do kill -0 $p 2>/dev/null && kill -KILL $p; done; exit 0',
      'sh',
      signal,
      String(rootPid),
      ...tree.map(String),
    ],
    { timeoutMs: 15_000 },
  )
}

const TERMINAL_TAB = `on run argv
  set target to item 1 of argv
  tell application "Terminal"
    repeat with w in windows
      repeat with t in tabs of w
        if tty of t is target then
          if (count of argv) > 1 then do script (item 2 of argv) in t
          set selected tab of w to t
          set index of w to 1
          activate
          return "ok"
        end if
      end repeat
    end repeat
  end tell
  return "missing"
end run`

const ITERM_TAB = `on run argv
  set target to item 1 of argv
  tell application "iTerm2"
    repeat with w in windows
      repeat with t in tabs of w
        repeat with s in sessions of t
          if tty of s is target then
            select w
            select t
            select s
            activate
            if (count of argv) > 1 then tell s to write text (item 2 of argv)
            return "ok"
          end if
        end repeat
      end repeat
    end repeat
  end tell
  return "missing"
end run`

function focusTab($: EngineInterface, app: string, tty: string, command?: string): Promise<RunResult> {
  const argv = ['osascript', '-', tty, ...(command ? [command] : [])]

  return run($, argv, { stdin: app === 'iTerm2' ? ITERM_TAB : TERMINAL_TAB })
}

function openInTerminal($: EngineInterface, command: string): Promise<RunResult> {
  return run($, ['osascript', '-', command], {
    stdin: `on run argv
  tell application "Terminal"
    do script (item 1 of argv)
    activate
  end tell
end run`,
  })
}

function openUrl($: EngineInterface, port: number): Promise<RunResult> {
  return run($, ['open', `http://localhost:${port}`])
}

function quote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`
}

function rescanSoon($: EngineInterface): void {
  $.clock.after(1500, () => void scan($))
  $.clock.after(5000, () => void scan($))
}

async function report($: EngineInterface, r: RunResult, failure?: string, success?: string): Promise<void> {
  if (failure) return void $.ui.toast(failure)
  if (r.exitCode !== 0) return void $.ui.toast(`Failed: ${(r.stderr || r.stdout).trim().split('\n')[0] || `exit ${r.exitCode}`}`)
  if (success) $.ui.toast(success)
}

async function run($: EngineInterface, argv: string[], init?: { stdin?: string; timeoutMs?: number }): Promise<RunResult> {
  try {
    return await $.process.run(argv, init)
  } catch (err) {
    return { exitCode: 127, stdout: '', stderr: String(err) }
  }
}
