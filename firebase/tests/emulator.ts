/** Host/port of an emulator from its env var (set by `firebase emulators:exec`) or a default. */
export function emulatorHost(variable: string, fallback: string): [string, number] {
  const value = (process.env[variable] ?? fallback).replace(/^https?:\/\//, "");
  const [host, port] = value.split(":");
  return [host, Number(port)];
}
