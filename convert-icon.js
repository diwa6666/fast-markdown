const pngToIco = require('png-to-ico');
const fs = require('fs');

pngToIco('assets/icon.png')
    .then(buf => {
        fs.writeFileSync('assets/icon.ico', buf);
        console.log('Icon converted successfully!');
    })
    .catch(err => {
        console.error('Error:', err);
    });
