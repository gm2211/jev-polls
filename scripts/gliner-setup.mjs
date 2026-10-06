import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Select a supported interpreter without installing packages into system Python.
const candidates = process.env.JEV_GLINER_PYTHON
  ? [process.env.JEV_GLINER_PYTHON]
  : ['python3.11', 'python3.12', 'python3.13', 'python3.10', 'python3', 'python'];
const python = candidates.find(executable => {
  const probe = spawnSync(executable, ['-c', 'import sys; print("%d.%d" % sys.version_info[:2])'], { encoding: 'utf8', timeout: 5000 });
  const version = /^(\d+)\.(\d+)\s*$/.exec(probe.stdout ?? '');
  return probe.status === 0 && version?.[1] === '3' && Number(version[2]) >= 10 && Number(version[2]) <= 13;
});
if (!python) {
  process.stdout.write(JSON.stringify({ ready: false, error: 'Install Python 3.10–3.13, or set JEV_GLINER_PYTHON to a compatible interpreter path.' }) + '\n');
  process.exitCode = 1;
} else {
  const child = spawn(python, [fileURLToPath(new URL('./gliner_setup.py', import.meta.url))], { stdio: 'inherit' });
  child.on('error', () => { process.stdout.write(JSON.stringify({ ready: false, error: 'Could not launch GLiNER setup.' }) + '\n'); process.exitCode = 1; });
  child.on('exit', code => { process.exitCode = code ?? 1; });
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => child.kill(signal));
}
