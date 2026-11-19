// Execute the date formatters used by the two VibeCheck screens on the selected revision.
// The VM supplies Intl and Date in the Dallas time zone. No Spotify account is needed.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
process.env.TZ = 'America/Chicago';
const cases = [
  ['2026-05-16', 'Sat, May 16, 2026', 'Saturday, May 16, 2026'],
  ['2026-01-01', 'Thu, Jan 1, 2026', 'Thursday, January 1, 2026'],
  ['2026-05-16T03:00:00Z', 'Fri, May 15, 2026', 'Friday, May 15, 2026'],
];
let failed = 0;
for (const [index, page] of ['EventsPage', 'EventDetailPage'].entries()) {
  const source = fs.readFileSync(path.join('Music_Show_Helper', 'Frontend', 'src', 'pages', page + '.tsx'), 'utf8');
  const match = source.match(/  const formatDate = \(dateString: string\) => \{([\s\S]*?)\r?\n  \};/);
  if (!match || !source.includes('{formatDate(event.date)}')) throw Error('Inspect the date formatter in ' + page + ' and update this probe.');
  const format = vm.runInNewContext('(dateString) => {' + match[1] + '}');
  for (const [input, ...expected] of cases) {
    const actual = format(input);
    const ok = actual === expected[index];
    console.log((ok ? 'PASS' : 'FAIL') + ' ' + page + '  ' + input + '  =>  ' + actual + (ok ? '' : '  (expected ' + expected[index] + ')'));
    if (!ok) failed++;
  }
}
process.exitCode = failed ? 1 : 0;
