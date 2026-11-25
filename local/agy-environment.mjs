import { homedir } from 'node:os'
import { dirname } from 'node:path'

const agyKeys = [
  'AGY_ADC_AUTH',
  'GOOGLE_APPLICATION_CREDENTIALS',
  'GOOGLE_CLOUD_PROJECT',
  'GOOGLE_CLOUD_QUOTA_PROJECT',
  'LANG',
  'LC_ALL',
]

export function agyLaunch(binary, workerArgs, { env = process.env, home = homedir() } = {}) {
  const setup = env.VIA_AGY_SETUP
  const workerEnv = {
    HOME: home,
    PATH: [dirname(binary), '/usr/bin', '/bin', '/usr/sbin', '/sbin'].join(':'),
  }
  for (const key of agyKeys) {
    if (env[key]) workerEnv[key] = env[key]
  }
  if (!setup) return { command:binary, args:workerArgs, env:workerEnv }
  return {
    command: '/bin/zsh',
    args: ['-f', '-c', 'source "$1" && typeset -f agy >/dev/null || exit 1; shift; agy "$@"', 'via-agy', setup, ...workerArgs],
    env: workerEnv,
  }
}
