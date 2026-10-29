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

const LSOF = ['p670', 'cControlCenter', 'n*:7000', 'p500', 'cnode', 'n127.0.0.1:5173', 'p600', 'cnext-server', 'n*:3010', 'p19904', 'cOrbStack Helper', 'n*:8000', 'n127.0.0.1:32222', 'p700', 'cPython', 'n192.168.1.20:5173', ''].join('\n')

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
  '19904     1 08-03:00:00 ??       /Applications/OrbStack.app/Contents/Frameworks/OrbStack Helper.app/Contents/MacOS/OrbStack Helper',
].join('\n')

const PS_ARGS = [
  '  490 npm run dev',
  '  500 /opt/homebrew/bin/node /Users/me/code/web/node_modules/.bin/vite',
  '  595 npm exec next dev -p 3010',
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
  on('command.register', () => ({ value: { command: 'servers' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('clock.every', () => ({ value: undefined }))
  on('clock.now', () => ({ value: Date.parse('2026-10-28T12:00:00Z') }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('process.run', (_, e) => {
    const cmd = e.argv.join(' ')
    if (cmd.startsWith('lsof -nP')) return ok(LSOF)
    if (cmd.includes('pid=,ppid=,etime=,tty=,comm=')) return ok(PS_META)
    if (cmd.includes('pid=,args=')) return ok(PS_ARGS)
    if (cmd.startsWith('docker ps')) return ok(DOCKER)
    if (cmd.startsWith('lsof -a -d cwd')) return ok('p490\nfcwd\nn/Users/me/code/web/.claude/worktrees/feat-x/app\np595\nfcwd\nn/Users/me/code/site\n')
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
})
