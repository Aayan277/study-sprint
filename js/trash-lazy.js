// What the delete screens call, without loading the Recently deleted code until a delete really happens (see js/trash.js).
// keepDeleted never throws; forgetDeleted(handle) takes the entry out again when the Undo toast brought the rows back.
export const keepDeleted = async (...args) => { try { return await (await import('./trash.js')).keepDeleted(...args); } catch (err) { console.error('Recently deleted:', err); return null; } };
export const forgetDeleted = async handle => { if (handle) { try { await (await import('./trash.js')).forgetDeleted(handle); } catch (err) { console.error('Recently deleted:', err); } } };
