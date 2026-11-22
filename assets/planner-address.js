(() => {
  const normalized = value => String(value ?? '').normalize('NFKC').trim()
    .toLocaleLowerCase('en-US').replace(/[,\s]+/g, ' ').trim();

  function exactAddress(results, query) {
    if (results.length === 1) return results[0];
    const input = normalized(query);
    if (!input) return null;
    const exact = results.filter(result => normalized(result.display_name) === input);
    return exact.length === 1 ? exact[0] : null;
  }

  globalThis.routePlannerAddress = {exactAddress};
})();
