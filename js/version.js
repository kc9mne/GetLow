/* GetLow version and what changed. Bump VERSION for each release you upload and
   put the newest entry first: GetLow shows it once after an update. */
(function () {
  'use strict';
  const GL = window.GL = window.GL || {};
  GL.VERSION = '1.1.1';
  GL.CHANGES = [
    { v: '1.1.1', date: '2026-11-24', items: [
      'Add a driver from the start page (paste specs or a .wdr file), or from New project when it isn\'t listed: it is picked for you.',
      'Subwoofers can be 5.25" and 6.5" in New project.',
      'Your own drivers show their nominal size (a pasted 5-1/4" woofer is 5.25", not its 4" cone).',
    ] },
    { v: '1.1.0', date: '2026-11-20', items: [
      'Back up everything to one file and restore it (Tools tab); GetLow asks the browser to keep its storage.',
      'Undo and redo for design changes (Ctrl+Z, Ctrl+Y).',
      'Save any chart as a picture (PNG) or its curves as a spreadsheet (CSV).',
      'EQ on the Signal tab: Linkwitz transform and parametric bands, with excursion and max SPL following the boost.',
      'Import measurements (.frd response, .zma impedance) from REW, ARTA and others, to compare with the simulation.',
      'Build sheet: butt, rabbet or mitre joints, a terminal cup cutout and driver screw holes.',
      'Export the panels for a CNC or laser cutter (DXF, SVG) and the box for a 3D printer (STL).',
      'Passive crossover designer: 2- and 3-way, with part values, simulated against each driver\'s impedance.',
      'Power compression (voice coil heating) and excursion-dependent BL and suspension at high power.',
      'MIT licence: free and open source.',
      'Box shape on the Enclosure tab: lock up to two dimensions and the volume moves the third, never smaller than the drivers need.',
      'Changing the enclosure type keeps your box (and a line array\'s column) and tunes the port for it.',
      'Round ports on any wall: front, back, sides, top or bottom; on "auto" they move off a full front.',
      'Number arrows step by about a tenth of the value (1.5, 1.4, 1.3 …), and nothing that must be positive can go to zero or below.',
      'Side view centred on the speaker, with angle lines every 10°. Port tubes default to 1/8" walls.',
      'A new look: GetLow red, a splash screen while it starts, the artwork on the start page and new app icons. Chart line colours checked for colour blindness (the fourth is now yellow).',
    ] },
    { v: '1.0.0', date: '2026-11-20', items: [
      'Installable app: works offline and offers "Update now" when a new version is uploaded.',
    ] },
  ];
})();
