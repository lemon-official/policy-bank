import { expect, test } from 'claude-code/testing'

const PANE = {
  plugin: 'running-servers',
  component: 'Pane',
  requestId: 'running-servers',
  props: {
    title: 'Servers',
    isFocused: false,
    bodyColumns: 60,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 40 },
    view: {},
  },
} as const

const LSOF = ['p670', 'cControlCenter', 'n*:7000', 'p500', 'cnode', 'n127.0.0.1:5173', 'p600', 'cnext-server', 'n*:3010', 'p19904', 'cOrbStack Helper', 'n*:8000', 'n127.0.0.1:32222', 'p700', 'cPython', 'n192.168.1.20:5173', 'p800', 'cuv', 'n127.0.0.1:8010', ''].join('\n')

const PS_META = [
  '    1     0 08-03:15:14 ??       /sbin/launchd',
  '  670     1 08-03:15:00 ??       /System/Library/CoreServices/ControlCenter.app/Contents/MacOS/ControlCenter',
  '  100     1 01-00:00:00 ??       /Applications/iTerm.app/Contents/MacOS/iTerm2',
  '  110   100    10:00 s003     -zsh',
  '  490   110    05:00 s003     npm run dev',
  '  500   490    04:59 s003     node',
  '  590     1 02:00:00 ??       bash',
  '  595   590 02:00:00 ??       npm exec next dev -p 3010',
  '  600   595 01:59:59 ??       next-server (v16.3.6)',
  '  700     1    01:00 ??       /usr/bin/python3',
  '  800     1    00:01 ??       uv',
  '19904     1 08-03:00:00 ??       /Applications/OrbStack.app/Contents/Frameworks/OrbStack Helper.app/Contents/MacOS/OrbStack Helper',
].join('\n')

const PS_ARGS = [
  '  490 npm run dev',
  '  500 /opt/homebrew/bin/node /Users/me/code/web/node_modules/.bin/vite',
  '  595 npm exec next dev -p 3010',
  '  800 uv run uvicorn api.main:app --port 8010',
  '  700 /usr/bin/python3 -c exec("import asyncio") running-servers-expose 5173 192.168.1.20',
].join('\n')

const DOCKER = JSON.stringify({
  Names: 'umcp-backend-1',
  Image: 'umcp-backend',
  Ports: '0.0.0.0:8000->8000/tcp, [::]:8000->8000/tcp',
  Labels: 'com.docker.compose.project=umcp,com.docker.compose.project.working_dir=/Users/me/code/umcp',
})

const ok = (stdout: string, exitCode = 0) => ({ value: { exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })

test('lists terminal, docker and detached servers, and filters by origin', async ($, on) => {
  const opened: string[] = []
  on('command.register', () => ({ value: { command: 'servers' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('clock.every', () => ({ value: undefined }))
  on('clock.after', () => ({ value: undefined }))
  on('clock.now', () => ({ value: Date.parse('2026-10-28T12:00:00Z') }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.cwd', () => ({ value: '/Users/me/code/web/.claude/worktrees/feat-x' }))
  on('tool.call', () => ({ result: {} }))
  on('process.run', (_, e) => {
    const cmd = e.argv.join(' ')
    if (cmd.startsWith('open ')) opened.push(cmd)
    if (cmd.startsWith('lsof -nP')) return ok(LSOF)
    if (cmd.includes('pid=,ppid=,etime=,tty=,comm=')) return ok(PS_META)
    if (cmd.includes('pid=,args=')) return ok(PS_ARGS)
    if (cmd.startsWith('docker ps')) return ok(DOCKER)
    if (cmd.startsWith('lsof -a -d cwd')) return ok('p490\nfcwd\nn/Users/me/code/web/.claude/worktrees/feat-x/app\np595\nfcwd\nn/Users/me/code/site\np800\nfcwd\nn/Users/me/code/UMCP\n')
    if (cmd.startsWith('docker inspect')) return ok('/umcp-backend-1|2026-10-28T10:00:00Z\n')
    if (cmd.startsWith('git -C /Users/me/code/web/')) {
      return ok('/Users/me/code/web/.claude/worktrees/feat-x\nfeature/x\n/Users/me/code/web/.git\n')
    }
    if (cmd.startsWith('git ')) return ok('', 128)
    if (cmd === 'ipconfig getifaddr en0') return ok('192.168.1.20\n')
    if (cmd === 'scutil --get LocalHostName') return ok('mbp\n')
    if (cmd === 'tailscale status --json') {
      return ok(JSON.stringify({ BackendState: 'Running', Self: { DNSName: 'mbp.tailnet-example.ts.net.', TailscaleIPs: ['100.64.0.1', 'fd7a::1'] } }))
    }

    return ok('')
  })

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  // Let the scan started at session.start finish.
  await new Promise(r => setTimeout(r, 50))

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  // Grouped under the main repo, then by worktree with its branch; named by subfolder.
  expect((await ui.find({ type: 'Text', text: /⎇ feat-x/ }))?.text).toContain('feature/x')
  expect(await ui.find({ type: 'Text', text: /🖥️ app$/ })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /📁 ~\/code\/web$/ })).toBeTruthy()
  // How it runs and where it is reachable stay folded until the row is opened.
  expect(await ui.find({ type: 'Text', text: /iTerm2 · ttys003/ })).toBeFalsy()
  expect(await ui.find({ type: 'Button', key: 'pid:490:addr:192.168.1.20:5173' })).toBeFalsy()
  await ui.press({ key: 'pid:490:more' })
  await ui.press({ key: 'pid:595:more' })
  await ui.press({ key: 'docker:umcp-backend-1:more' })
  expect((await ui.find({ type: 'Text', text: /iTerm2 · ttys003/ }))?.text).toBe('npm run dev  ·  iTerm2 · ttys003')
  expect(await ui.find({ type: 'Text', text: /^5m ago$/ })).toBeTruthy()
  expect((await ui.find({ type: 'Text', text: /compose umcp/ }))?.text).toContain('umcp-backend-1')
  expect(await ui.find({ type: 'Text', text: /📁 ~\/code\/site/ })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /^2h ago$/ })).toBeTruthy()
  expect(await ui.find({ type: 'Button', key: 'pid:490:port:5173' })).toBeTruthy()
  expect(await ui.find({ type: 'Button', key: 'docker:umcp-backend-1:restart' })).toBeTruthy()
  expect(await ui.find({ type: 'Button', key: 'pid:490:shell' })).toBeTruthy()
  // LAN: the forwarded vite port and next's all-interfaces port show their
  // addresses, Tailscale included; the forwarder itself is no row.
  expect(await ui.find({ type: 'Button', key: 'pid:490:addr:192.168.1.20:5173' })).toBeTruthy()
  expect(await ui.find({ type: 'Button', key: 'pid:490:lan' })).toBeTruthy()
  expect(await ui.find({ type: 'Button', key: 'pid:490:expose' })).toBeFalsy()
  expect(await ui.find({ type: 'Button', key: 'pid:595:addr:mbp.local:3010' })).toBeTruthy()
  expect(await ui.find({ type: 'Button', key: 'pid:595:addr:mbp.tailnet-example.ts.net:3010' })).toBeTruthy()
  expect(await ui.find({ type: 'Button', key: 'pid:595:lan' })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /python3/ })).toBeFalsy()
  // ControlCenter and OrbStack's own port are apps, hidden from the dev view.
  expect(await ui.find({ type: 'Text', text: /ControlCenter/ })).toBeFalsy()
  await ui.select({ key: 'filter', value: 'docker' })
  await ui.unmount()

  const docker = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await docker.find({ type: 'Text', text: /npm run dev/ })).toBeFalsy()
  expect(await docker.find({ type: 'Text', text: /umcp-backend-1/ })).toBeTruthy()
  await docker.unmount()

  // The bar: uv started in a Bash call of this chat, vite in the session's worktree.
  await $.tool.call({ tool: 'Bash', command: 'uv run uvicorn api.main:app --port 8010 &' })
  const bandProps = (bodyColumns: number) => ({
    plugin: 'running-servers',
    component: 'AbovePrompt',
    props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns, scroll: { offset: 0, bodyRows: 10 }, view: {} },
  }) as const
  for (const surface of ['desktop', 'terminal'] as const) {
    const band = await $.ui.mount({ ...bandProps(100), surface })
    await band.resize({ columns: 90, rows: 3, in: 'bar:strip' })
    // A known app gets its own icon; this chat's service carries no tag.
    expect(await band.find({ type: 'Text', text: /^🦮 UMCP$/, in: 'bar:strip' })).toBeTruthy()
    expect(await band.find({ type: 'Text', text: /^just now$/, in: 'bar:strip' })).toBeTruthy()
    expect((await band.find({ type: 'Text', text: /worktree/, in: 'bar:strip' }))?.text).toBe('⎇ worktree · 5m ago')
    expect(await band.find({ type: 'Text', text: /site/, in: 'bar:strip' })).toBeFalsy()
    expect(await band.find({ type: 'Text', text: /›/, in: 'bar:strip' })).toBeFalsy()
    await band.unmount()
  }

  // Too narrow for both: a counter, and dragging (or a key) slides the strip.
  const narrow = await $.ui.mount({ ...bandProps(40), surface: 'desktop' })
  await narrow.resize({ columns: 30, rows: 3, in: 'bar:strip' })
  expect((await narrow.find({ type: 'Text', text: /›/, in: 'bar:strip' }))?.text).toBe('+1›')
  await narrow.pointer({ type: 'down', x: 20, y: 1, button: 'left' })
  await narrow.pointer({ type: 'move', x: -15, y: 1, button: 'left' })
  await narrow.pointer({ type: 'up', x: -15, y: 1, button: 'left' })
  expect((await narrow.find({ type: 'Text', text: /‹/, in: 'bar:strip' }))?.text).toBe('‹1')
  await narrow.key({ key: 'home' })
  expect(await narrow.find({ type: 'Text', text: /‹/, in: 'bar:strip' })).toBeFalsy()
  // A port chip pressed in the strip opens the page.
  await narrow.post({ open: 8010 })
  expect(opened).toContain('open http://localhost:8010')
  await narrow.unmount()
})
