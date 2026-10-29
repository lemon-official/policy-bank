export type Origin = 'terminal' | 'docker' | 'claude' | 'background' | 'app'

export type Server = {
  id: string
  origin: Origin
  // Worktree (or repo) plus subfolder when in git, else the folder or command.
  name: string
  ports: number[]
  // The main repository's root (shared by its worktrees), else the folder;
  // '' when there is none. What the pane groups by.
  group: string
  // The git worktree's root (the main checkout's too): the subgroup in a group.
  worktree?: string
  branch?: string
  // Epoch ms the service's root process (or container) started.
  startedAt?: number
  // Ports reachable from the LAN: bound to all interfaces, or forwarded.
  lan?: number[]
  // This mod's LAN forwarders for the service's loopback-only ports.
  forwards?: { port: number; pid: number }[]
  // Where it was started, e.g. "iTerm2 · ttys003" or "Docker · compose umcp".
  where: string
  cwd?: string
  pid?: number
  // The topmost process of the service below its shell/launcher: what gets
  // killed and run again on restart.
  rootPid?: number
  command?: string
  terminalApp?: string
  tty?: string
  container?: string
}

export type Network = {
  lanIp?: string
  // Bonjour name, e.g. "mbp.local".
  host?: string
  // Set only while Tailscale is connected.
  tailscaleName?: string
  tailscaleIp?: string
}

declare module 'claude-code' {
  interface PluginState {
    'running-servers': {
      servers: Shaped<Server[]>
      filter: string
      scanning: boolean
      scannedAt: number
      network: Shaped<Network>
      // Ids of the rows whose details (command, where, addresses) are unfolded.
      expanded: string[]
    }
  }
}
