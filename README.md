# mekamb-download-manager

Prosty web UI do pobierania plików: wklejasz URL, podajesz folder docelowy i klikasz.
Aplikacja pobiera na serwerze (strumieniowo) i zapisuje atomowo (najpierw `.part`, potem `rename`).

## Szybki start (docker compose)

```bash
cp .env.example .env
# edytuj .env: ustaw AUTH_USER/AUTH_PASS (login + haslo) i port
docker compose up -d --build
```

Aplikacja działa pod **subdomeną Traefika** (domyślnie `http://downloader.home` — nazwę zmieniasz
labelem `subdomain:` w docker-compose.yml) oraz bezpośrednio na porcie LAN (`http://HOST:DM_HOST_PORT`).
Wklej token z `.env` w polu "Access token" na górze strony.

## Środowisko

| Zmienna | Domyślnie | Opis |
|---|---|---|
| `AUTH_USER` | `lofis` | Login do web UI (Basic auth) |
| `AUTH_PASS` | *(brak)* | Hasło do web UI. Jeśli puste — brakuje autoryzacji (uwaga w logach) |
| `DM_HOST_PORT` | `3000` | Port na hoście (w docker-compose.yml) |
| `BLOCK_PRIVATE_IPS` | `false` | `true` = odrzuca URL-e prowadzące do IP prywatnych/LAN (ochrona przed SSRF); wyłącz, jeśli chcesz pobierać z NAS-a po LAN |
| `MAX_CONCURRENT_JOBS` | `3` | Maks. równoległych pobierań |
| `QBT_API_URL` | `http://qbittorrent-filmy:8081/api/v2` | API WebUI kontenera qBittorrenta (ta sama sieć docker `proxy`) |
| `QBT_USER` / `QBT_PASS` | `admin` / *(brak)* | Logowanie do WebUI qBittorrenta. Puste `QBT_PASS` = integracja wyłączona (zakładka i cap prędkości nieaktywne) |
| `NTFY_URL` | `http://ntfy` | Adres własnego serwera ntfy (kontener na sieci `proxy`, DNS po nazwie) |
| `NTFY_TOPIC` | `serwer` | Temat docelowy powiadomień. Pusty = powiadomienia wyłączone |
| `NTFY_USER` / `NTFY_PASS` | `admin` / *(brak)* | Logowanie do ntfy (serwer ma login enabled → bez tego 401). Hasło patrz `~/docker/ntfy/credentials.txt` |
| `ROOT_DIR` | `/data` | Korzeń, pod którym leżą foldery docelowe (w kontenerze) |
| `PORT` | `3000` | Port wewnętrzny kontenera |

## API

Wszystko pod `/api`, autoryzacja Basic authem (nagłówek `Authorization: Basic base64(login:hasło)`,
np. z curl: `-u lofis:twoje-haslo`):

- `POST /api/jobs` — body `{"url": "https://…", "dest": "optional/sub/dir"}` → `201` z jobem
- `GET  /api/jobs` — lista jobów + postęp (`receivedBytes`, `totalBytes`)
- `DELETE /api/jobs/:id` — anulowanie
- `GET  /api/dirs` — istniejące foldery (podpowiedzi w UI)
- `GET  /api/status`, `GET /healthz`
- `GET  /api/qbt/status` — czy qBittorrent jest skonfigurowany/dostępny + aktualny limit DL (B/s, 0 = brak)
- `GET  /api/qbt/torrents` — torrenty, które nie są jeszcze zakończone (bez seedujących)
- `POST /api/qbt/torrents` — dodanie: `{"magnet": "magnet:?xt=…"}` albo `{"b64": "<plik .torrent>", "filename": "x.torrent"}`
- `POST /api/qbt/pause`, `POST /api/qbt/resume` — body `{"hashes": ["…"]}`

## qBittorrent (zakładka + limit prędkości)

Manager jest wrapperem wokół kontenera `qbittorrent-filmy`:

- **Zakładka „qBittorrent"** — wyświetla torrenty, które są jeszcze w trakcie pobierania
  (pauzowane/w kolece/meta/error; seedujące nie są pokazywane). Da się je pauzować/wznawiać
  oraz dodawać nowy torrent przez magnet link albo plik `.torrent`. Operacje idą prosto do
  API WebUI qBittorrenta — zadania wykonuje faktyczny klient, a nasz manager tylko je przejmuje.
- **Respektowanie limitów** — co 30 s manager odczytuje z API qBittorrenta aktualny globalny
  limit pobierania (ten sam, który ustawia `~/docker/arr/scripts/qbt-speed-schedule.sh`:
  noc bez limitu, w dzień 1 MiB/s / w weekendy 500 KiB/s) i capuje nim **sumę** wszystkich
  własnych pobierań. Limit widoczny jest jako pasek „Download speed cap" w UI.
  Jeśli qBittorrent nie odpowiada (2 odświeżenia z rzędu) — limit znoszony, pobieranie bez ograniczeń.
- Kod jest kompatybilny z Web API v4 i ≥5 (nazwy endpointów `pause`/`stop`, parametr `mt`/`urls`).

## ntfy (powiadomienia na telefon)

Po zakończeniu pobierania manager wysyła push na własny serwer ntfy
(`http://ntfy.home` — temat `serwer`, który odczytuje telefon):

- **Pobranie zakończone** → tytuł „Download finished” + ścieżka pliku i rozmiar.
- **Pobranie nie powiodło się** → „Download failed” (wyższy priorytet) + błąd.
- Anulowane joby (kliknięcie 🗑 podczas pobierania) nie wysyłają niczego.

Wysyłka jest fire-and-forget z timeoutem 5 s — padnięty ntfy nigdy nie psuje
zakończenia pobierania, a jedynie zostaje wpis w logach. Autoryzacja: Basic auth
serwera ntfy (domyślnie konto `admin` z `~/docker/ntfy/credentials.txt`).

## Ścieżki plików

- `dest` jest względem `ROOT_DIR`; folder tworzony automatycznie.
- Nazwa pliku: z nagłówka `Content-Disposition`, inaczej z URL-a. Kolizje dostają sufiks `-1`, `-2`, …
- Pobieranie kończy się atomowym `rename` — po awarii zostaje tylko `.part`.

## Bezpieczeństwo

- Kontener działa jako nie-root (user `node`, uid 1000).
- Autoryzacja tokenem porównywana `timingSafeEqual` (hash SHA-256, brak wycieku długości).
- Tylko `http:`/`https:`; opcjonalny filtr SSRF na IP prywatne.
- Walidacja ścieżki docelowej + ochrona przed ucieczką przez symlink (`realpath`).
- Ograniczenie body do 4 MB (pod uploady `.torrent`), limit równoległych jobów, watchdog (job bez danych >15 min → abort).
- CSP `default-src 'self'`, `nosniff`, brak inline scriptów.

## Deployment na serwer

Serwer używa wzorca z Traefikiem (por. `~/docker/proxy`): usługa trafia do katalogu
`~/docker/<nazwa>`, labelem `subdomain:` dostaje subdomenę i dołącza do zewnętrznej sieci `proxy`.

```bash
rsync -a --exclude node_modules --exclude .git ./ lofis@192.168.0.107:~/docker/download-manager/
ssh lofis@192.168.0.107 'cd ~/docker/download-manager && cp .env.example .env'
# ustaw AUTH_USER i AUTH_PASS w .env, potem:
ssh lofis@192.168.0.107 'cd ~/docker/download-manager && docker compose up -d --build'
```

Efekt: http://downloader.home oraz http://192.168.0.107:3000 (LAN).

## Testy lokalne (bez dockera)

```bash
npm install
ROOT_DIR=/tmp/dm-test AUTH_USER=admin AUTH_PASS=pass PORT=3999 node server.js
# logowanie: admin / pass
# http://localhost:3999
```
