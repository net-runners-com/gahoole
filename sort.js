import fs from 'fs';
const numbers = fs.readFileSync('nums.txt', 'utf8')
  .trim()
  .split('\n')
  .map(Number);
numbers.sort((a, b) => a - b);
console.log(numbers.join('\n'));