/** `1.5 GB` — binary units (1 KB = 1024 bytes), one decimal. */
function formatBytes(bytes: number): string {
  const units = ['bytes', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return unit === 0 ? `${value} ${value === 1 ? 'byte' : 'bytes'}` : `${value.toFixed(1)} ${units[unit]}`;
}

export { formatBytes };
