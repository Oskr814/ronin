// Exploration's clock (EXPLORE_TIMEZONE): the nightly window, the date of a
// run, the week of its PR follow the team's time, not the server's (often
// UTC). Only exploration uses it — everything else, logs included, keeps the
// server's time.

export function assertTimezone(timezone: string): string {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone });
  } catch {
    throw new Error(`EXPLORE_TIMEZONE inválida: "${timezone}" (usar un nombre IANA, ej. America/Tegucigalpa)`);
  }
  return timezone;
}

// The wall clock in `timezone` at `date`: its calendar day and minutes past midnight.
export function wallClock(date: Date, timezone: string): { day: string; minutes: number } {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
      .formatToParts(date)
      .map((p) => [p.type, p.value]),
  );
  return { day: `${parts.year}-${parts.month}-${parts.day}`, minutes: Number(parts.hour) * 60 + Number(parts.minute) };
}

export function dayIn(date: Date, timezone: string): string {
  return wallClock(date, timezone).day;
}

// "YYYY-MM-DD" plus `days`, as a calendar date.
export function addDays(day: string, days: number): string {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

// The instant when the wall clock in `timezone` reads `minutes` past
// midnight of `day` (minutes may reach 24:00).
export function instantAt(day: string, minutes: number, timezone: string): Date {
  const [y, m, d] = day.split('-').map(Number);
  const asUtc = Date.UTC(y, m - 1, d, 0, minutes);
  // The zone's offset at that moment, read back from its wall clock; done
  // twice so a DST change between the guess and the answer settles.
  let instant = asUtc;
  for (let i = 0; i < 2; i++) {
    const wall = wallClock(new Date(instant), timezone);
    const [wy, wm, wd] = wall.day.split('-').map(Number);
    const wallAsUtc = Date.UTC(wy, wm - 1, wd, 0, wall.minutes);
    instant = asUtc - (wallAsUtc - instant);
  }
  return new Date(instant);
}
