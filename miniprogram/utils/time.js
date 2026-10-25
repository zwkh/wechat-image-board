function formatTime(timestamp) {
  if (!timestamp) return '';
  // 固定显示北京时间，不受手机时区影响。
  const date = new Date(Number(timestamp) + 8 * 60 * 60 * 1000);
  if (Number.isNaN(date.getTime())) return '';
  const pad = n => String(n).padStart(2, '0');
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())} ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}`;
}

module.exports = { formatTime };
