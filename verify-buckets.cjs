const m = require('./src/reportBuckets.js');

const tests = [
  ['proto', m.bucketOf({key:'__proto__',status:'bad',remedy:'dns'}) === 'dns'],
  ['constructor', m.bucketOf({key:'constructor',status:'warn'}) === 'partial'],
  ['toString', m.bucketOf({key:'toString',status:'bad'}) === 'partial'],
  ['guide', m.guideFor('toString',false) === ''],
  ['group', Array.isArray(m.groupItems([{key:'__proto__',status:'bad',remedy:'dns'}]).dns)]
];

for (const [name, passed] of tests) {
  console.log(name + ': ' + (passed ? 'PASS' : 'FAIL'));
}

if (tests.some(([, passed]) => !passed)) process.exitCode = 1;
