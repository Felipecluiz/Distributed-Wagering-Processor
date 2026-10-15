import { Clock, IdGenerator } from '../application/ports';

export const systemClock: Clock = { now: () => new Date() };
export const uuidGenerator: IdGenerator = { next: () => crypto.randomUUID() };