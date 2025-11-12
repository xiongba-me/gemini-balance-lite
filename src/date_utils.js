export function getLocalDate(timeZone = 'America/Los_Angeles') {
  const date = new Date();
  // 使用 'en-CA' locale 可以直接得到 YYYY-MM-DD 格式
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  });
  return formatter.format(date);
}