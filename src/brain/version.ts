/** True when version a is newer than version b ("0.10.0" is newer than "0.9.1"). A leading "v" is ignored. */
export function newer(a: string, b: string): boolean {
  const parts = (v: string) => v.replace(/^v/, "").split(".").map((n) => parseInt(n, 10) || 0);
  const [x, y] = [parts(a), parts(b)];
  for (let i = 0; i < 3; i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) > (y[i] ?? 0);
  return false;
}
