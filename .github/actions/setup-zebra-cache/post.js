const rawPid = process.env.STATE_pid ?? '';
const pid = Number.parseInt(rawPid, 10);

if (Number.isInteger(pid) && pid > 0) {
  try {
    process.kill(pid, 'SIGTERM');
  } catch (error) {
    if (error?.code !== 'ESRCH') {
      throw error;
    }
  }
}
