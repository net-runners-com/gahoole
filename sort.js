const fs = require('fs');
const data = fs.readFileSync('bench-tmp/nums.txt', 'utf8');
const nums = data.trim().split('
').map(Number);
nums.sort((a, b) => a - b);
fs.writeFileSync('bench-tmp/sorted.txt', nums.join('
') + '
');
