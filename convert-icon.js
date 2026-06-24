const sharp = require('sharp');
const fs = require('fs');

async function convertIcon() {
  try {
    await sharp('icon.png')
      .resize(256, 256)
      .toFormat('png')
      .toFile('icon_fixed.png');
    console.log('Successfully fixed and resized icon to icon_fixed.png');
  } catch (err) {
    console.error('Error converting icon:', err);
  }
}

convertIcon();
