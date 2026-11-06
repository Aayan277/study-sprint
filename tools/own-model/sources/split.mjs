// Which group a learner belongs to when the data has real people in it: decided by a hash of the id, so it never depends on the
// order of files or on how many users are present. 0 to 66 train, 67 to 79 validation, 80 to 99 test. Splits are by learner, never by review.
import { fnv1a } from '../../../js/rwkv-features.js';

export const SPLIT_SALT = 'own-split|';
export const bucketOf = id => fnv1a(SPLIT_SALT + id) % 100;
export const splitOf = id => { const b = bucketOf(id); return b < 67 ? 'train' : b < 80 ? 'val' : 'test'; };
