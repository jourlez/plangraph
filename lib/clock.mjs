// "Now" for every output or stored date. SOURCE_DATE_EPOCH (whole seconds since the epoch, digits only) overrides the clock so a run is
// reproducible; anything else in it is ignored. Pure: takes the environment and a clock, holds no state. Lock and timeout code keeps
// reading the real clock on purpose.
/** @param {Record<string, string | undefined>} [env] @param {() => Date} [clock] @returns {Date} */
export function sourceNow(env = {}, clock = () => new Date()) {
  const v = env.SOURCE_DATE_EPOCH;
  if (typeof v === 'string' && /^\d{1,15}$/.test(v)) { const d = new Date(Number(v) * 1000); if (Number.isFinite(d.getTime())) return d; }
  return clock();
}
export const isoDay = (/** @type {Date} */ date) => date.toISOString().slice(0, 10);
