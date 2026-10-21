// Starts the maths code only when maths is on the page. app.js calls watchMath() at start-up; this file is tiny, and the
// big one (math.js, which draws formulas with KaTeX) is only loaded once a formula (an element with the class `tex`) shows up,
// or if one is already there. math.js's own watchMath() then takes over: it draws everything on the page, keeps drawing
// formulas added later, retries when the phone comes back online, and re-checks scrolling formulas after a resize.
// Until then there is nothing to retry or resize, so waiting costs nothing.

export function watchMath() {
  let loading = false;
  const hasTex = n => n.nodeType === 1 && (n.matches?.('.tex') || !!n.querySelector?.('.tex'));
  const observer = new MutationObserver(muts => {
    for (const m of muts) for (const n of m.addedNodes) if (hasTex(n)) { start(); return; }
  });
  const watch = () => observer.observe(document.body, { childList: true, subtree: true });
  const start = () => {
    if (loading) return;
    loading = true;
    observer.disconnect();
    // If the file can't be fetched (offline before it was saved), watch again so the next formula tries once more.
    import('./math.js').then(m => m.watchMath()).catch(err => { loading = false; console.error(err); watch(); });
  };
  if (document.querySelector('.tex')) start(); else watch();
}
