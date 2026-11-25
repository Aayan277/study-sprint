// What the delete screens call, without loading the Recently deleted code until a delete really happens (see js/trash.js).
// keepDeleted never throws, and the delete screens do not wait for it: `const kept = keepDeleted(...)`, show the Undo toast at once;
// the Undo handler calls forgetLater(kept) after restoring. forgetDeleted(handle) takes the entry out again when the Undo toast brought the rows back.
export const keepDeleted = async (...args) => { try { return await (await import('./trash.js')).keepDeleted(...args); } catch (err) { console.error('Recently deleted:', err); return null; } };
export const forgetDeleted = async handle => { if (handle) { try { await (await import('./trash.js')).forgetDeleted(handle); } catch (err) { console.error('Recently deleted:', err); } } };
// Undo does not wait for the entry to be written (keepDeleted may still be running, or stuck): once it is saved, it is taken out again.
export const forgetLater = kept => { Promise.resolve(kept).then(forgetDeleted).catch(() => {}); };
