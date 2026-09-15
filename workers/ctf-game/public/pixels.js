function validate(image) {
  if (!image || !Number.isInteger(image.width) || !Number.isInteger(image.height) || image.width < 1 || image.height < 1
    || image.width * image.height > 4_194_304 || image.data.length !== image.width * image.height * 4) throw Error('图像尺寸无效');
}

export function floodFill(image, x, y, rgba) {
  validate(image);
  if (!Number.isInteger(x) || !Number.isInteger(y) || x < 0 || y < 0 || x >= image.width || y >= image.height || rgba.length !== 4) throw Error('像素坐标无效');
  const data = image.data, width = image.width, height = image.height, at = (y * width + x) * 4;
  const original = Array.from(data.subarray(at, at + 4)), fill = Uint8ClampedArray.from(rgba);
  if (original.every((value, channel) => value === fill[channel])) return 0;
  const queue = new Uint32Array(width * height); let head = 0, tail = 0;
  function add(pixel) {
    const offset = pixel * 4;
    if (!original.every((value, channel) => data[offset + channel] === value)) return;
    data.set(fill, offset); queue[tail++] = pixel;
  }
  add(y * width + x);
  while (head < tail) {
    const pixel = queue[head++], column = pixel % width;
    if (column) add(pixel - 1);
    if (column + 1 < width) add(pixel + 1);
    if (pixel >= width) add(pixel - width);
    if (pixel + width < width * height) add(pixel + width);
  }
  return tail;
}

export function rotatePixels(image, clockwise = true) {
  validate(image);
  const output = new Uint8ClampedArray(image.data.length), width = image.height, height = image.width;
  for (let y = 0; y < image.height; y++) for (let x = 0; x < image.width; x++) {
    const nextX = clockwise ? image.height - 1 - y : y, nextY = clockwise ? x : image.width - 1 - x;
    output.set(image.data.subarray((y * image.width + x) * 4, (y * image.width + x) * 4 + 4), (nextY * width + nextX) * 4);
  }
  return { width, height, data: output };
}
