const { syllabify, syllableCount } = require('../practice.js');

const TRUTH = {
  // 1 syllable
  cat: 1, dog: 1, sun: 1, tree: 1, ship: 1, night: 1, fright: 1, light: 1, book: 1,
  house: 1, make: 1, have: 1, play: 1, rain: 1, three: 1, goat: 1, coat: 1, sheep: 1,
  // 2
  apple: 2, table: 2, little: 2, coffee: 2, teacher: 2, water: 2, orange: 2, pencil: 2,
  rabbit: 2, window: 2, garden: 2, morning: 2, castle: 2, dragon: 2, monster: 2, sandwich: 2,
  purple: 2, candle: 2, rocket: 2, tiger: 2, music: 2, sunny: 2, happy: 2, hungry: 2,
  // 3
  banana: 3, computer: 3, beautiful: 3, family: 3, animal: 3, chocolate: 3, important: 3,
  holiday: 3, dinosaur: 3, hospital: 3, elephant: 3, butterfly: 3, adventure: 3, remember: 3,
  // 4
  vegetable: 4, interesting: 4, comfortable: 3, dictionary: 4,
};

let ok = 0, bad = [];
for (const [w, n] of Object.entries(TRUTH)) {
  const got = syllableCount(w);
  if (got === n) ok++;
  else bad.push(`${w}: got ${got} ${JSON.stringify(syllabify(w))} want ${n}`);
}
console.log(`accuracy ${ok}/${Object.keys(TRUTH).length} = ${(ok / Object.keys(TRUTH).length * 100).toFixed(1)}%`);
if (bad.length) { console.log('\nmismatches:'); bad.forEach(b => console.log('  ' + b)); }

console.log('\nsample splits:');
['banana', 'table', 'orange', 'coffee', 'teacher', 'fright', 'vegetable', 'beautiful', 'butterfly']
  .forEach(w => console.log(`  ${w.padEnd(12)} -> ${syllabify(w).join(' · ')}  (${syllableCount(w)})`));
