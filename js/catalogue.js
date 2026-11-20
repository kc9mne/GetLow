/* GetLow – catalogue helpers. Parts Express drivers scraped from product
 * pages (data/catalogue-pe.js, from tools/build-pe-extra.py) are read with the same spec
 * reader as Paste specs, screened, and merged into the OpenISD catalogue. */
(function (GL) {
  'use strict';
  // Read the scraped Parts Express pages with the same spec reader as Paste
  // specs. A Vas that is off by exactly litres/ft³ (Sd and Cms agree) is fixed;
  // anything else that doesn't add up is left out.
  function mergePartsExpress(cat, extra) {
    if (!extra || cat.pe) return;
    const rc2 = GL.phys.rc2(), FT3 = 0.0283168;
    const kept = [], skipped = [];
    let fixed = 0;
    for (const r of extra.raw) {
      const parsed = GL.specparse.parse(r.text);
      const p = Object.assign({}, parsed.params);
      let fix = false, sdEst = false;
      // fill a missing Sd or Vas from the other values (exact), or Sd from the frame size (estimate)
      const w = 2 * Math.PI * (p.fs || 0);
      const cms = p.Cms > 0 ? p.Cms : (p.Mms > 0 && w > 0 ? 1 / (w * w * p.Mms) : 0);
      if (!(p.sd > 0) && p.vas > 0 && cms > 0) p.sd = Math.sqrt(p.vas / (rc2 * cms));
      else if (!(p.sd > 0) && p.dia > 0 && p.vas > 0) { p.sd = Math.PI * Math.pow(0.78 * p.dia / 2, 2); sdEst = true; }
      if (!(p.vas > 0) && p.sd > 0 && cms > 0) p.vas = rc2 * p.sd * p.sd * cms;
      if (p.vas > 0 && p.sd > 0 && p.Cms > 0) {
        const ratio = p.vas / (rc2 * p.sd * p.sd * p.Cms);
        if (Math.abs(ratio / (1 / 0.001 * FT3) - 1) < 0.15) { p.vas /= FT3 / 0.001; fix = true; }        // litres shown as ft³
        else if (Math.abs(ratio * (FT3 / 0.001) - 1) < 0.15) { p.vas *= FT3 / 0.001; fix = true; }   // ft³ shown as litres
      }
      // Sd typed in m² but labelled cm² (0.014 "cm²"): rescale when the frame size agrees
      const sdGuess = p.dia > 0 ? Math.PI * Math.pow(0.78 * p.dia / 2, 2) : 0;
      const plausibleSd = (x) => !sdGuess || (x > sdGuess * 0.45 && x < sdGuess * 1.7);
      if (p.sd > 0 && sdGuess && !plausibleSd(p.sd) && plausibleSd(p.sd * 1e4)) { p.sd *= 1e4; fix = true; }
      // Vas that disagrees with Sd and Cms (often a tiny ft³ value rounded to 2 decimals):
      // trust Sd·Cms when Fs agrees with Mms and Cms and Sd fits the frame
      let vasCalc = false;
      if (p.vas > 0 && p.sd > 0 && p.Cms > 0 && p.Mms > 0 && p.fs > 0 && plausibleSd(p.sd)) {
        const v = rc2 * p.sd * p.sd * p.Cms;
        const fsOk = Math.abs(1 / (2 * Math.PI * Math.sqrt(p.Mms * p.Cms)) / p.fs - 1) < 0.1;
        if (fsOk && Math.abs(Math.log(p.vas / v)) > Math.log(1.15)) { p.vas = v; vasCalc = true; }
      }
      const warns = GL.specparse.check(p).filter(n => n[0] === 'warn');
      if (warns.length) { skipped.push({ name: r.brand + ' ' + r.model, why: warns[0][1] }); continue; }
      if (fix || vasCalc) fixed++;
      kept.push({ id: r.id, brand: r.brand, model: r.model, desc: r.desc, page: r.page, p, types: r.types, size: r.size,
        vc: parsed.dvc ? { coils: 2, published: parsed.dvc.published, perCoil: parsed.dvc.perCoil } : undefined,
        price: r.price, pn: r.pn, peBox: r.peBox, src: 'pe', fixedVas: fix || vasCalc, sdEst });
    }
    cat.drivers = cat.drivers.concat(kept);
    cat.pe = { kept: kept.length, fixed, skipped, scraped: extra.scraped };
  }


  GL.catalogueTools = { mergePartsExpress };
})(window.GL);
