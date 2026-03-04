const fs = require('fs');
const path = require('path');

const rootDir = path.resolve(__dirname, '..');
const targetPath = path.join(rootDir, 'update-config.json');
const examplePath = path.join(rootDir, 'update-config.example.json');

if (fs.existsSync(targetPath)) {
    console.log('update-config.json already exists.');
    process.exit(0);
}

if (!fs.existsSync(examplePath)) {
    console.error('Missing update-config.example.json.');
    process.exit(1);
}

fs.copyFileSync(examplePath, targetPath);
console.log('Created update-config.json from update-config.example.json');
