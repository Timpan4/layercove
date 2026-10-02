# SpoolBuddy hardware setup

SpoolBuddy is a Raspberry Pi station with a PN5180 NFC reader and a NAU7802 scale. It reads filament tags and spool weight and reports them to LayerCove. Pi 4 and Pi 5 are supported.

## Install

`install/install.sh` configures SPI and I2C, installs packages, and sets up the daemon as a systemd service. Its default repository is still upstream Bambuddy, so pass `--repo` explicitly:

```bash
curl -fsSL https://raw.githubusercontent.com/Timpan4/layercove/main/spoolbuddy/install/install.sh -o install.sh
chmod +x install.sh
sudo ./install.sh --mode spoolbuddy \
  --repo https://github.com/Timpan4/layercove.git \
  --bambuddy-url http://<layercove-host>:8000 \
  --api-key <api-key>
```

`--bambuddy-url` is a retained option name; give it your LayerCove URL. Run `./install.sh --help` for all options. Use `--mode spoolbuddy` only: `--mode full` also installs a native server, which LayerCove does not support.

The sections below cover wiring and the manual steps the installer automates.

## PN5180 NFC reader (SPI)

### Wiring

| PN5180 pin | Raspberry Pi pin | GPIO | Wire color |
|---|---|---|---|
| 3V3 | Pin 1 | — | Red |
| 5V | Pin 2 | — | Red |
| GND | Pin 20 | — | Black |
| SCK | Pin 23 | GPIO11 | Yellow |
| MISO | Pin 21 | GPIO9 | Blue |
| MOSI | Pin 19 | GPIO10 | Green |
| NSS (CS) | Pin 16 | GPIO23 | Orange |
| BUSY | Pin 22 | GPIO25 | White |
| RST | Pin 18 | GPIO24 | Brown |

> **Power:** 3V3 powers the IC and 5V powers the antenna booster, which extends read range. Connect both. Connecting 5V to the 3V3 pin destroys the reader.

> **Chip select:** NSS is wired to GPIO23 and driven manually, because the kernel SPI driver's automatic CE0 timing does not meet the PN5180's 5 µs setup and 100 µs hold requirements. The daemon asks the driver to disable CE0 toggling and tolerates the Pi 5 RP1 driver rejecting that request.

Solder all wires. Wago connectors and breadboard jumpers cause RF field flicker and intermittent SPI errors with the PN5180.

The daemon reads `SPOOLBUDDY_NFC_NSS_PIN`, `SPOOLBUDDY_NFC_BUSY_PIN`, `SPOOLBUDDY_NFC_RST_PIN`, `SPOOLBUDDY_NFC_SPI_BUS`, `SPOOLBUDDY_NFC_SPI_DEVICE`, and `SPOOLBUDDY_NFC_SPI_SPEED_HZ` if you wire it differently. Defaults match the table above, SPI bus 0 device 0, at 500 kHz in SPI mode 0. Higher speeds cause communication errors.

## NAU7802 scale (I2C)

### Wiring

| NAU7802 pin | Raspberry Pi pin | GPIO | Wire color |
|---|---|---|---|
| VCC | Pin 1 | — | Red |
| SDA | Pin 3 | GPIO2 | Yellow |
| SCL | Pin 5 | GPIO3 | White |
| GND | Pin 30 | — | Black |

The scale uses I2C bus 1 (GPIO2/GPIO3).

## Manual setup

### 1. Enable SPI and I2C

```bash
sudo raspi-config
# Interface Options -> SPI -> Enable
# Interface Options -> I2C -> Enable
```

### 2. Configure `/boot/firmware/config.txt`

Add these lines under `[all]`:

```
# SpoolBuddy: I2C bus 1 for the NAU7802 scale (GPIO2/GPIO3)
dtparam=i2c_arm=on

# SpoolBuddy: disable SPI auto chip select (manual CS on GPIO23 for the PN5180)
dtoverlay=spi0-0cs
```

Reboot, then check the devices:

```bash
sudo reboot
ls /dev/spidev0.*     # expect /dev/spidev0.0
ls /dev/i2c-1
sudo i2cdetect -y 1   # expect 0x2a (NAU7802)
```

### 3. Install packages

```bash
sudo apt install python3-spidev python3-libgpiod gpiod libgpiod3 i2c-tools
python3 -m venv --system-site-packages spoolbuddy/venv
spoolbuddy/venv/bin/pip install spidev gpiod smbus2
```

Raspberry Pi OS blocks system-wide `pip install`, so the Python packages go into a virtual environment, as the installer does. The `gpiod` Python package provides GPIO access on both Pi 4 and Pi 5. The `gpiod` apt package adds command-line GPIO tools for debugging.

### 4. Check the NFC reader

```bash
sudo spoolbuddy/venv/bin/python spoolbuddy/scripts/pn5180_diag.py
```

The output includes the product version (for example `v4.0`), firmware version, a register dump, and `Diagnostics complete`.

### 5. Read a tag

```bash
sudo spoolbuddy/venv/bin/python spoolbuddy/scripts/read_tag.py
```

| Tag type | SAK | Use |
|---|---|---|
| MIFARE Classic 1K | `0x08` | Bambu Lab filament tags |
| MIFARE Classic 4K | `0x18` | Bambu Lab filament tags |
| NTAG 213/215/216 | `0x00` / `0x04` | SpoolEase, OpenPrintTag |

### 6. Check the scale

```bash
sudo spoolbuddy/venv/bin/python spoolbuddy/scripts/scale_diag.py
```

The script reads 10 samples at 10 SPS and prints raw ADC values, the average, and the spread. Idle readings are typically around 500k with a spread under 20k.

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| SPI reads return all zeros | SPI disabled | Enable SPI in `raspi-config` and reboot |
| `GENERAL_ERROR` on `SEND_DATA` | Automatic CS timing too fast | Use manual CS on GPIO23 with the `spi0-0cs` overlay |
| `BUSY timeout` | Wiring fault or RST not connected | Check the RST and BUSY connections |
| RF field flickers on and off | Loose power wires | Solder all connections |
| `No tag found` with a tag present | Wrong protocol setup | Use ISO 14443A config (`0x00, 0x80`) and call `setTransceiveMode()` before every `SEND_DATA` |
| Auth failed for block N | Wrong key derivation | HKDF must use the context `"RFID-A\0"` (7 bytes including the null terminator) |
| `EBUSY` requesting GPIO8 | Kernel SPI driver owns CE0 | Wire NSS to GPIO23 |
