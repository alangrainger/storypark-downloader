/** Timestamped console logger. */
const stamp = () => new Date().toISOString()
export const log = {
  info: (msg: string) => console.log(`${stamp()} INFO  ${msg}`),
  warn: (msg: string) => console.warn(`${stamp()} WARN  ${msg}`),
  error: (msg: string) => console.error(`${stamp()} ERROR ${msg}`),
}
