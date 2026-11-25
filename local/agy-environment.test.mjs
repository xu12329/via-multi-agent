import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { agyLaunch } from './agy-environment.mjs'

test('AGY worker runs its scoped wrapper without inheriting sibling or shell startup environment', async t => {
  const home = await mkdtemp(join(tmpdir(), 'via-agy-env-'))
  t.after(() => rm(home, { recursive: true, force: true }))
  const binary = join(home, 'bin', 'agy')
  const setup = join(home, 'config/agy-wrapper.zsh')
  await mkdir(dirname(binary), { recursive: true })
  await mkdir(dirname(setup), { recursive: true })
  const parentEnv = {
    HOME: home,
    VIA_AGY_SETUP: setup,
    PATH: dirname(binary) + ':/usr/bin:/bin',
    AGY_ADC_AUTH: 'synthetic-agy-auth',
    GOOGLE_CLOUD_PROJECT: 'synthetic-agy-project',
    CODEX_HOME: '/synthetic-codex',
    XDG_CONFIG_HOME: '/synthetic-parent',
    OPENAI_API_KEY: 'synthetic-foreign-key',
    ANTHROPIC_API_KEY: 'synthetic-foreign-key',
    HTTPS_PROXY: 'synthetic-parent-route',
  }
  await writeFile(join(home, '.zshenv'), 'export VIA_SHELL_CANARY=loaded\n')
  await writeFile(setup, 'agy() { VIA_AGY_ROUTE=worker-only command agy "$@"; }\n')
  await writeFile(binary, '#!/bin/sh\n' + [
    'printf "%s\\n" "$VIA_AGY_ROUTE" "$VIA_SHELL_CANARY" "$AGY_ADC_AUTH" "$GOOGLE_CLOUD_PROJECT" "$CODEX_HOME" "$XDG_CONFIG_HOME" "$OPENAI_API_KEY" "$ANTHROPIC_API_KEY" "$HTTPS_PROXY" "$*"',
  ].join('\n') + '\n')
  await chmod(binary, 0o700)
  const startupControl = execFileSync('/bin/zsh', ['-c', 'print -r -- "$VIA_SHELL_CANARY"'], { env: parentEnv, encoding: 'utf8' })
  assert.equal(startupControl.trim(), 'loaded')
  const unfiltered = execFileSync(binary, ['acp'], { env: parentEnv, encoding: 'utf8' }).split('\n')
  assert.equal(unfiltered[4], parentEnv.CODEX_HOME)
  assert.equal(unfiltered[8], parentEnv.HTTPS_PROXY)
  const launch = agyLaunch(binary, ['acp', '--sandbox'], { env: parentEnv, home })
  assert.deepEqual(execFileSync(launch.command, launch.args, { env: launch.env, encoding: 'utf8' }).split('\n'), [
    'worker-only', '', parentEnv.AGY_ADC_AUTH, parentEnv.GOOGLE_CLOUD_PROJECT, '', '', '', '', '', 'acp --sandbox', '',
  ])
  const nextShell = execFileSync('/bin/zsh', ['-f', '-c', 'print -r -- "$VIA_AGY_ROUTE"'], { env: launch.env, encoding: 'utf8' })
  assert.equal(nextShell.trim(), '')
  await writeFile(setup, '# The AGY wrapper entry is missing.\n')
  assert.throws(() => execFileSync(launch.command, launch.args, { env: launch.env, stdio: 'pipe' }), { status: 1 })
})
