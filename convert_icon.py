from PIL import Image
import os

# 打开PNG图片
img = Image.open('assets/icon.png')

# 确保是RGBA模式
if img.mode != 'RGBA':
    img = img.convert('RGBA')

# 只保存最大的尺寸，通常兼容性更好
img.save('assets/icon.ico', format='ICO', sizes=[(256, 256)])

print('图标转换成功！')
print('已创建: assets/icon.ico (256x256)')
