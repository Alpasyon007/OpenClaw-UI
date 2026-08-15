import { describe, expect, it } from 'vitest'
import { runCliAsync, runBinAsync } from '../../src/main/cli-probe'

/**
 * The probe throttle.
 *
 * Every CLI call in the app funnels through a two-slot semaphore, because a
 * single `openclaw` invocation parses a ~90 MB module graph and an unbounded
 * fan-out of them stalls the machine. That makes the release path load-bearing:
 * a slot leaked once is leaked for the life of the process, and every later
 * probe — start-up info, model list, gateway status — queues behind it forever.
 *
 * `execFile` can throw synchronously rather than calling back (a malformed
 * command path does it), which is the case that used to escape the release.
 */

describe('runBinAsync', () => {
  it('resolves rather than rejecting when the binary does not exist', async () => {
    const res = await runBinAsync('definitely-not-a-real-binary-xyzzy', ['--version'], 5000)
    expect(res.ok).toBe(false)
    expect(typeof res.stderr).toBe('string')
  })

  it('releases its slot on failure, so later probes still run', async () => {
    // More consecutive failures than there are slots. If a failing call leaked
    // its slot this would hang and the suite's timeout would fire.
    for (let i = 0; i < 4; i++) {
      await runBinAsync('definitely-not-a-real-binary-xyzzy', ['--version'], 5000)
    }

    const ok = await runBinAsync(process.execPath, ['-e', 'process.stdout.write("alive")'], 10_000)
    expect(ok.ok).toBe(true)
    expect(ok.stdout).toBe('alive')
  })

  it('survives a batch of concurrent failures without deadlocking', async () => {
    await Promise.all(
      Array.from({ length: 6 }, () =>
        runBinAsync('definitely-not-a-real-binary-xyzzy', ['--version'], 5000),
      ),
    )
    const ok = await runBinAsync(process.execPath, ['-e', 'process.stdout.write("still here")'], 10_000)
    expect(ok.stdout).toBe('still here')
  })

  it('reports a non-zero exit as not ok while still returning output', async () => {
    const res = await runBinAsync(
      process.execPath,
      ['-e', 'process.stdout.write("partial"); process.exit(3)'],
      10_000,
    )
    expect(res.ok).toBe(false)
    expect(res.stdout).toBe('partial')
  })

  it('trims surrounding whitespace from both streams', async () => {
    const res = await runBinAsync(process.execPath, ['-e', 'process.stdout.write("  padded  ")'], 10_000)
    expect(res.stdout).toBe('padded')
  })
})

describe('runCliAsync', () => {
  it('resolves with a failure result when the CLI is absent', async () => {
    // No openclaw binary is guaranteed on a CI machine; either outcome is fine,
    // the point is that it settles and reports rather than throwing.
    const res = await runCliAsync(['--version'], 8000)
    expect(res).toMatchObject({
      ok: expect.any(Boolean),
      stdout: expect.any(String),
      stderr: expect.any(String),
    })
  })
})
