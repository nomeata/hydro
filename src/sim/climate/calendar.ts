import type { SimTime } from '../../shared/protocol';
import { DAYS_PER_SEASON, DAYS_PER_YEAR, STEPS_PER_DAY } from '../constants';
import { PARAMS } from '../params';

/**
 * The game starts in the morning of the first day of spring. `step` counts
 * hydro steps since world creation.
 */
const START_TIME_OF_DAY = 0.3;

export function timeAt(step: number): SimTime {
  const dayF = step / STEPS_PER_DAY + START_TIME_OF_DAY;
  const day = Math.floor(dayF);
  const dayOfYear = day % DAYS_PER_YEAR;
  return {
    step,
    day,
    year: Math.floor(day / DAYS_PER_YEAR),
    season: Math.floor(dayOfYear / DAYS_PER_SEASON),
    dayOfSeason: dayOfYear % DAYS_PER_SEASON,
    yearFrac: (dayF % DAYS_PER_YEAR) / DAYS_PER_YEAR,
    timeOfDay: dayF - day,
  };
}

/**
 * Sea-level air temperature (°C). Coldest in mid-winter (yearFrac ≈ 0.875),
 * warmest in mid-summer (≈ 0.375), plus a small diurnal swing.
 */
export function seaLevelTemperature(t: SimTime, anomaly = 0): number {
  const seasonal = PARAMS.tempMean + PARAMS.tempAmplitude * Math.sin(2 * Math.PI * (t.yearFrac - 0.125));
  const diurnal = 3 * Math.sin(2 * Math.PI * (t.timeOfDay - 0.375));
  return seasonal + diurnal + anomaly;
}
