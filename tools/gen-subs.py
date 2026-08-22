#!/usr/bin/env python3
"""
Генератор подписок и списка клиентов Xray из people.yaml.

Запуск из корня репозитория:
    SOPS_AGE_KEY_FILE=~/main/keys/flux-home.key python3 tools/gen-subs.py

Переписывает два файла целиком, оба зашифрованные SOPS:
    apps/vps/xray/config.yaml   — секция clients
    apps/vps/subs/content.yaml  — по файлу подписки на человека

Скрипт идемпотентен: повторный запуск на неизменном people.yaml даёт
тот же результат. Правки в сгенерированных файлах руками будут стёрты.
"""
import base64
import json
import pathlib
import subprocess
import sys
from urllib.parse import quote

ROOT = pathlib.Path(__file__).resolve().parent.parent


def sops(args):
    r = subprocess.run(["sops", *args], capture_output=True, text=True)
    if r.returncode != 0:
        sys.exit(f"sops {' '.join(args)}: {r.stderr.strip()}")
    return r.stdout


def load_yaml(text):
    try:
        import yaml
    except ImportError:
        sys.exit("нужен PyYAML: pip install pyyaml")
    return yaml.safe_load(text)


def vless_link(srv, person):
    """Ссылка ровно того вида, который понимают v2rayNG, Happ и v2rayN."""
    params = (
        f"encryption=none&type=xhttp&path={quote('/', safe='')}"
        f"&host={srv['host']}&mode=auto&security=reality"
        f"&sni={srv['sni']}&fp=chrome&pbk={srv['publicKey']}"
        f"&sid={srv['shortId']}&spx={quote('/', safe='')}"
    )
    return f"vless://{person['uuid']}@{srv['host']}:{srv['port']}?{params}#{srv['profileTitle']}"


# Правила маршрутизации, которые Happ подхватывает из заголовка ответа.
# Родне не нужно ничего настраивать: вставили ссылку — приехало всё.
ROUTING = {
    "Name": "",
    "GlobalProxy": "true",
    "RouteOrder": "block-proxy-direct",
    "RemoteDNSType": "DoH",
    "RemoteDNSDomain": "",
    "RemoteDNSIP": "",
    "DomesticDNSType": "DoU",
    "DomesticDNSDomain": "",
    "DomesticDNSIP": "",
    "Geoipurl": "",
    "Geositeurl": "",
    "LastUpdated": "",
    "DnsHosts": {},
    # Мимо туннеля: российские сайты (иначе банки увидят вход из Германии)
    # и обновления операционных систем — их незачем тащить через Германию.
    "DirectSites": [
        "geosite:category-ru",
        "regexp:.*\\.ru",
        "geosite:yandex",
        "geosite:mailru",
        "geosite:apple",
        "geosite:microsoft",
        "geosite:google-play",
    ],
    "DirectIp": ["geoip:private", "geoip:ru"],
    "ProxySites": [],
    "ProxyIp": [],
    "BlockSites": ["geosite:category-ads-all"],
    "BlockIp": [],
    "DomainStrategy": "IPIfNonMatch",
    "FakeDNS": "false",
    "UseChunkFiles": "true",
}


def main():
    # people.yaml зашифрован: в нём UUID и токены — фактические ключи доступа.
    data = load_yaml(sops(["--decrypt", str(ROOT / "people.yaml")]))
    srv, people = data["server"], data["people"]
    if len({p["sub"] for p in people}) != len(people):
        sys.exit("токены подписок повторяются — доступы пересекутся")

    # 1. Список клиентов в конфиге Xray.
    cfg_path = ROOT / "apps/vps/xray/config.yaml"
    doc = load_yaml(sops(["--decrypt", str(cfg_path)]))
    xray = json.loads(doc["stringData"]["config.json"])
    xray["inbounds"][0]["settings"]["clients"] = [
        {"id": p["uuid"], "email": p["name"]} for p in people
    ]
    doc["stringData"]["config.json"] = json.dumps(xray, ensure_ascii=False, indent=2) + "\n"

    import yaml
    cfg_path.write_text(yaml.safe_dump(doc, allow_unicode=True, sort_keys=False), encoding="utf-8")
    sops(["--encrypt", "--in-place", str(cfg_path)])

    # 2. Файлы подписок. Формат стандартный: base64 от списка ссылок.
    subs = {
        p["sub"]: base64.b64encode(vless_link(srv, p).encode()).decode()
        for p in people
    }
    subs_doc = {
        "apiVersion": "v1",
        "kind": "Secret",
        "metadata": {"name": "subs-content", "namespace": "subs"},
        "type": "Opaque",
        "stringData": {
            **subs,
            "routing.txt": "happ://routing/add/"
            + base64.b64encode(json.dumps(ROUTING, ensure_ascii=False).encode()).decode(),
            "title.txt": base64.b64encode(srv["profileTitle"].encode()).decode(),
        },
    }
    # 3. Конфиг nginx. Генерируется здесь же, потому что заголовок routing
    #    обязан приезжать из того же источника, что и сами подписки —
    #    иначе правила и адреса разъедутся при следующей правке.
    routing_header = "happ://routing/add/" + base64.b64encode(
        json.dumps(ROUTING, ensure_ascii=False).encode()
    ).decode()
    title_header = "base64:" + base64.b64encode(srv["profileTitle"].encode()).decode()
    nginx_conf = f"""server {{
  listen 8080;
  server_name _;

  # Неугаданный токен не должен отличаться от несуществующего пути:
  # снаружи и то, и другое — обычная 404 страница сервера.
  error_page 404 = @notfound;
  location @notfound {{
    default_type text/html;
    return 404 '<html><head><title>404 Not Found</title></head><body><center><h1>404 Not Found</h1></center><hr><center>nginx</center></body></html>';
  }}

  location /sub/ {{
    alias /srv/sub/;
    default_type text/plain;
    add_header profile-title "{title_header}" always;
    add_header profile-update-interval "12" always;
    add_header subscription-userinfo "upload=0; download=0; total=0; expire=0" always;
    add_header routing "{routing_header}" always;
    # Подписку кэшировать нельзя: смена сервера должна доезжать сразу.
    add_header cache-control "no-store" always;
  }}

  location = / {{ return 404; }}
}}
"""
    nginx_doc = {
        "apiVersion": "v1",
        "kind": "ConfigMap",
        "metadata": {"name": "subs-nginx", "namespace": "subs"},
        "data": {"default.conf": nginx_conf},
    }
    (ROOT / "apps/vps/subs/nginx.yaml").write_text(
        yaml.safe_dump(nginx_doc, allow_unicode=True, sort_keys=False, default_style=None),
        encoding="utf-8",
    )

    subs_path = ROOT / "apps/vps/subs/content.yaml"
    subs_path.write_text(yaml.safe_dump(subs_doc, allow_unicode=True, sort_keys=False), encoding="utf-8")
    sops(["--encrypt", "--in-place", str(subs_path)])

    print(f"клиентов в Xray: {len(people)}")
    for p in people:
        print(f"  {p['name']:12} https://{srv['host']}/sub/{p['sub']}")
    print("\nдальше: бампнуть configVersion в apps/vps/xray/deployment.yaml, коммит, пуш")


if __name__ == "__main__":
    main()
