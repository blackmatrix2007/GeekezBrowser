#!/bin/bash
# Chạy 1 lần trên VPS để setup /updates route
# ssh root@103.163.215.48 'bash -s' < setup-vps-updates.sh

set -e

# Tạo thư mục
mkdir -p /var/www/yttool-updates

# Thêm nginx location /updates (trước location /admin)
NGINX_CONF="/etc/nginx/sites-enabled/yttool.vn"

# Kiểm tra đã có chưa
if grep -q "location /updates" "$NGINX_CONF"; then
    echo "✅ /updates đã có trong nginx"
else
    # Chèn trước location /admin
    sed -i '/location \/admin/i\    location /updates {\n        alias /var/www/yttool-updates;\n        autoindex off;\n        add_header Cache-Control "no-cache, no-store, must-revalidate";\n    }\n' "$NGINX_CONF"
    echo "✅ Đã thêm /updates vào nginx"
fi

nginx -t && systemctl reload nginx
echo "✅ Nginx reloaded"
echo "📁 Upload dir: /var/www/yttool-updates"
