/**
 * cars.js — Built-in catalog of electric vehicles.
 *
 * Every field here feeds directly into the physics model in physics.js.
 * The numbers come from published manufacturer specs and independent test
 * data, so treat them as good starting estimates rather than gospel — the
 * live calibration feature in the app corrects for whatever reality does
 * differently (tyre pressure, roof box, driving style, pack age).
 *
 * Field reference:
 *   id          unique key used in the <select> and in localStorage
 *   name        what the user sees
 *   usableKwh   USABLE battery energy, not gross. Manufacturers quote gross
 *               ("77 kWh") but reserve a buffer top and bottom to protect the
 *               cells. Using gross would make every prediction optimistic.
 *   massKg      kerb mass (empty car, no passengers). Passengers and cargo
 *               are added on top by the app.
 *   cd          drag coefficient — dimensionless "slipperiness".
 *   areaM2      frontal area — the cross-section the car pushes through the
 *               air. Aero drag depends on cd * area, so both matter.
 *
 *               Manufacturers almost never publish this number. Where it is
 *               not available it is estimated as 0.83 x width x height, which
 *               is the standard approximation in vehicle dynamics: a car's
 *               front is not a rectangle, and about 83% of its bounding box is
 *               actually solid. Width and height ARE always published, so this
 *               gives a consistent, defensible figure for every car.
 *   crr         rolling resistance coefficient of the tyres. Low-rolling-
 *               resistance EV tyres sit around 0.008–0.010; heavier SUVs and
 *               trucks on chunkier tyres run higher.
 *   eta         drivetrain efficiency — the fraction of energy leaving the
 *               battery that actually reaches the road (inverter + motor +
 *               reduction gear losses). Typically 0.86–0.92.
 *   heatPump    true if the car heats the cabin with a heat pump rather than
 *               a resistive element. This is a BIG deal in winter: a heat pump
 *               moves 2–3x more heat than the electricity it consumes, while a
 *               resistive heater is stuck at 1:1.
 */

export const CARS = [
  // ---- Tesla ----
  { id: 'tesla-m3-rwd',   name: 'Tesla Model 3 RWD',            usableKwh: 57.5, massKg: 1765, cd: 0.219, areaM2: 2.22, crr: 0.0090, eta: 0.91, heatPump: true },
  { id: 'tesla-m3-lr',    name: 'Tesla Model 3 Long Range AWD',  usableKwh: 75.0, massKg: 1830, cd: 0.219, areaM2: 2.22, crr: 0.0090, eta: 0.91, heatPump: true },
  { id: 'tesla-my-rwd',   name: 'Tesla Model Y RWD',             usableKwh: 57.5, massKg: 1909, cd: 0.230, areaM2: 2.51, crr: 0.0095, eta: 0.91, heatPump: true },
  { id: 'tesla-my-lr',    name: 'Tesla Model Y Long Range AWD',  usableKwh: 75.0, massKg: 1979, cd: 0.230, areaM2: 2.51, crr: 0.0095, eta: 0.91, heatPump: true },
  { id: 'tesla-ms',       name: 'Tesla Model S Long Range',      usableKwh: 95.0, massKg: 2130, cd: 0.208, areaM2: 2.34, crr: 0.0095, eta: 0.91, heatPump: true },
  { id: 'tesla-cybertruck', name: 'Tesla Cybertruck AWD',        usableKwh: 123.0, massKg: 3104, cd: 0.335, areaM2: 3.50, crr: 0.0115, eta: 0.90, heatPump: true },

  // ---- Hyundai / Kia ----
  { id: 'ioniq5-77',      name: 'Hyundai Ioniq 5 (77 kWh)',      usableKwh: 74.0, massKg: 2100, cd: 0.288, areaM2: 2.65, crr: 0.0100, eta: 0.89, heatPump: true },
  { id: 'ioniq6-77',      name: 'Hyundai Ioniq 6 (77 kWh)',      usableKwh: 74.0, massKg: 2020, cd: 0.210, areaM2: 2.42, crr: 0.0090, eta: 0.89, heatPump: true },
  { id: 'kona-64',        name: 'Hyundai Kona Electric (64 kWh)', usableKwh: 64.0, massKg: 1760, cd: 0.290, areaM2: 2.55, crr: 0.0095, eta: 0.89, heatPump: true },
  { id: 'ev6-lr',         name: 'Kia EV6 Long Range',            usableKwh: 74.0, massKg: 2015, cd: 0.280, areaM2: 2.60, crr: 0.0100, eta: 0.89, heatPump: true },
  { id: 'niro-ev',        name: 'Kia Niro EV',                   usableKwh: 64.8, massKg: 1757, cd: 0.290, areaM2: 2.55, crr: 0.0095, eta: 0.89, heatPump: true },

  // ---- Volkswagen Group ----
  { id: 'id4-pro',        name: 'VW ID.4 Pro (77 kWh)',          usableKwh: 77.0, massKg: 2124, cd: 0.280, areaM2: 2.56, crr: 0.0100, eta: 0.88, heatPump: false },
  { id: 'id3-pro',        name: 'VW ID.3 Pro (58 kWh)',          usableKwh: 58.0, massKg: 1794, cd: 0.267, areaM2: 2.36, crr: 0.0095, eta: 0.88, heatPump: false },
  { id: 'q4-45',          name: 'Audi Q4 e-tron 45',             usableKwh: 77.0, massKg: 2135, cd: 0.280, areaM2: 2.60, crr: 0.0100, eta: 0.88, heatPump: true },
  { id: 'taycan-4s',      name: 'Porsche Taycan 4S (Perf. Plus)', usableKwh: 83.7, massKg: 2220, cd: 0.220, areaM2: 2.33, crr: 0.0100, eta: 0.90, heatPump: true },

  // ---- BMW / Mercedes / Volvo / Polestar ----
  { id: 'i4-40',          name: 'BMW i4 eDrive40',               usableKwh: 81.5, massKg: 2050, cd: 0.240, areaM2: 2.36, crr: 0.0095, eta: 0.90, heatPump: true },
  { id: 'ix-50',          name: 'BMW iX xDrive50',               usableKwh: 105.0, massKg: 2510, cd: 0.250, areaM2: 2.72, crr: 0.0105, eta: 0.90, heatPump: true },
  { id: 'eqb-300',        name: 'Mercedes EQB 300 4MATIC',       usableKwh: 66.5, massKg: 2100, cd: 0.280, areaM2: 2.60, crr: 0.0100, eta: 0.88, heatPump: true },
  { id: 'polestar2-lr',   name: 'Polestar 2 Long Range Single',  usableKwh: 75.0, massKg: 2035, cd: 0.278, areaM2: 2.32, crr: 0.0095, eta: 0.89, heatPump: true },
  { id: 'ex30-er',        name: 'Volvo EX30 Extended Range',     usableKwh: 64.0, massKg: 1850, cd: 0.280, areaM2: 2.40, crr: 0.0095, eta: 0.89, heatPump: true },

  // ---- Nissan / Ford / Chevrolet / Rivian ----
  { id: 'leaf-40',        name: 'Nissan Leaf (40 kWh)',          usableKwh: 39.0, massKg: 1580, cd: 0.280, areaM2: 2.30, crr: 0.0095, eta: 0.87, heatPump: false },
  { id: 'leaf-62',        name: 'Nissan Leaf e+ (62 kWh)',       usableKwh: 59.0, massKg: 1736, cd: 0.280, areaM2: 2.30, crr: 0.0095, eta: 0.87, heatPump: false },
  { id: 'machE-er',       name: 'Ford Mustang Mach-E ER RWD',    usableKwh: 88.0, massKg: 2118, cd: 0.290, areaM2: 2.55, crr: 0.0100, eta: 0.89, heatPump: false },
  { id: 'bolt-ev',        name: 'Chevrolet Bolt EV',             usableKwh: 60.0, massKg: 1628, cd: 0.312, areaM2: 2.50, crr: 0.0095, eta: 0.87, heatPump: false },
  { id: 'r1t-large',      name: 'Rivian R1T (Large Pack)',       usableKwh: 135.0, massKg: 3175, cd: 0.300, areaM2: 3.40, crr: 0.0115, eta: 0.89, heatPump: true },

  // ---- Compact / value ----
  { id: 'zoe-r135',       name: 'Renault Zoe R135 (52 kWh)',     usableKwh: 52.0, massKg: 1502, cd: 0.310, areaM2: 2.30, crr: 0.0095, eta: 0.87, heatPump: false },
  { id: 'e208',           name: 'Peugeot e-208 (50 kWh)',        usableKwh: 46.0, massKg: 1530, cd: 0.290, areaM2: 2.20, crr: 0.0095, eta: 0.88, heatPump: true },
  { id: 'fiat500e',       name: 'Fiat 500e (42 kWh)',            usableKwh: 37.3, massKg: 1365, cd: 0.300, areaM2: 2.15, crr: 0.0095, eta: 0.88, heatPump: true },
  { id: 'mg4-64',         name: 'MG4 Long Range (64 kWh)',       usableKwh: 61.7, massKg: 1685, cd: 0.270, areaM2: 2.35, crr: 0.0095, eta: 0.88, heatPump: false },
  { id: 'atto3',          name: 'BYD Atto 3',                    usableKwh: 60.0, massKg: 1750, cd: 0.290, areaM2: 2.60, crr: 0.0100, eta: 0.88, heatPump: true },

  // =========================================================================
  // Expanded catalog. Same sourcing rules as above: usable (not gross) battery
  // energy, published kerb mass and Cd where available, frontal area from
  // 0.83 x width x height where it is not published.
  // =========================================================================

  // ---- Tesla (remaining trims) ----
  { id: 'tesla-m3-perf',  name: 'Tesla Model 3 Performance',     usableKwh: 75.0, massKg: 1892, cd: 0.219, areaM2: 2.22, crr: 0.0095, eta: 0.90, heatPump: true },
  { id: 'tesla-my-perf',  name: 'Tesla Model Y Performance',     usableKwh: 75.0, massKg: 2003, cd: 0.230, areaM2: 2.51, crr: 0.0100, eta: 0.90, heatPump: true },
  { id: 'tesla-ms-plaid', name: 'Tesla Model S Plaid',           usableKwh: 95.0, massKg: 2190, cd: 0.208, areaM2: 2.34, crr: 0.0100, eta: 0.90, heatPump: true },
  { id: 'tesla-mx-lr',    name: 'Tesla Model X Long Range',      usableKwh: 95.0, massKg: 2455, cd: 0.240, areaM2: 2.79, crr: 0.0105, eta: 0.90, heatPump: true },

  // ---- Hyundai / Kia / Genesis ----
  { id: 'ioniq5-58',      name: 'Hyundai Ioniq 5 (58 kWh)',      usableKwh: 55.0, massKg: 1935, cd: 0.288, areaM2: 2.65, crr: 0.0100, eta: 0.89, heatPump: true },
  { id: 'ioniq5-n',       name: 'Hyundai Ioniq 5 N',             usableKwh: 81.0, massKg: 2235, cd: 0.310, areaM2: 2.70, crr: 0.0110, eta: 0.88, heatPump: true },
  { id: 'ioniq6-53',      name: 'Hyundai Ioniq 6 (53 kWh)',      usableKwh: 53.0, massKg: 1855, cd: 0.210, areaM2: 2.42, crr: 0.0090, eta: 0.89, heatPump: true },
  { id: 'kona-48',        name: 'Hyundai Kona Electric (48 kWh)', usableKwh: 48.4, massKg: 1690, cd: 0.290, areaM2: 2.55, crr: 0.0095, eta: 0.89, heatPump: true },
  { id: 'ioniq9',         name: 'Hyundai Ioniq 9',               usableKwh: 110.3, massKg: 2625, cd: 0.259, areaM2: 3.00, crr: 0.0105, eta: 0.89, heatPump: true },
  { id: 'ev6-58',         name: 'Kia EV6 Standard (58 kWh)',     usableKwh: 54.0, massKg: 1890, cd: 0.280, areaM2: 2.60, crr: 0.0100, eta: 0.89, heatPump: true },
  { id: 'ev6-gt',         name: 'Kia EV6 GT',                    usableKwh: 74.0, massKg: 2200, cd: 0.300, areaM2: 2.62, crr: 0.0110, eta: 0.88, heatPump: true },
  { id: 'ev9-lr',         name: 'Kia EV9 Long Range',            usableKwh: 96.0, massKg: 2610, cd: 0.280, areaM2: 3.05, crr: 0.0110, eta: 0.89, heatPump: true },
  { id: 'ev3-lr',         name: 'Kia EV3 Long Range',            usableKwh: 78.0, massKg: 1885, cd: 0.263, areaM2: 2.55, crr: 0.0095, eta: 0.89, heatPump: true },
  { id: 'soul-ev',        name: 'Kia Soul EV (64 kWh)',          usableKwh: 64.0, massKg: 1682, cd: 0.310, areaM2: 2.60, crr: 0.0100, eta: 0.88, heatPump: true },
  { id: 'gv60',           name: 'Genesis GV60',                  usableKwh: 74.0, massKg: 2085, cd: 0.290, areaM2: 2.62, crr: 0.0100, eta: 0.89, heatPump: true },
  { id: 'gv70-ev',        name: 'Genesis Electrified GV70',      usableKwh: 74.0, massKg: 2250, cd: 0.330, areaM2: 2.70, crr: 0.0105, eta: 0.88, heatPump: true },
  { id: 'g80-ev',         name: 'Genesis Electrified G80',       usableKwh: 82.5, massKg: 2325, cd: 0.250, areaM2: 2.50, crr: 0.0100, eta: 0.89, heatPump: true },

  // ---- Volkswagen Group ----
  { id: 'id3-pro-s',      name: 'VW ID.3 Pro S (77 kWh)',        usableKwh: 77.0, massKg: 1934, cd: 0.267, areaM2: 2.36, crr: 0.0095, eta: 0.88, heatPump: false },
  { id: 'id4-52',         name: 'VW ID.4 Pure (52 kWh)',         usableKwh: 52.0, massKg: 1932, cd: 0.280, areaM2: 2.56, crr: 0.0100, eta: 0.88, heatPump: false },
  { id: 'id5-pro',        name: 'VW ID.5 Pro (77 kWh)',          usableKwh: 77.0, massKg: 2136, cd: 0.260, areaM2: 2.52, crr: 0.0100, eta: 0.88, heatPump: true },
  { id: 'id7-pro',        name: 'VW ID.7 Pro (77 kWh)',          usableKwh: 77.0, massKg: 2141, cd: 0.230, areaM2: 2.46, crr: 0.0095, eta: 0.89, heatPump: true },
  { id: 'id7-tourer',     name: 'VW ID.7 Tourer (86 kWh)',       usableKwh: 86.0, massKg: 2266, cd: 0.240, areaM2: 2.50, crr: 0.0100, eta: 0.89, heatPump: true },
  { id: 'idbuzz',         name: 'VW ID. Buzz (77 kWh)',          usableKwh: 77.0, massKg: 2471, cd: 0.290, areaM2: 3.30, crr: 0.0110, eta: 0.88, heatPump: true },
  { id: 'enyaq-60',       name: 'Skoda Enyaq 60',                usableKwh: 58.0, massKg: 2015, cd: 0.265, areaM2: 2.58, crr: 0.0100, eta: 0.88, heatPump: false },
  { id: 'enyaq-85',       name: 'Skoda Enyaq 85',                usableKwh: 77.0, massKg: 2145, cd: 0.265, areaM2: 2.58, crr: 0.0100, eta: 0.88, heatPump: true },
  { id: 'elroq-85',       name: 'Skoda Elroq 85',                usableKwh: 77.0, massKg: 2032, cd: 0.260, areaM2: 2.50, crr: 0.0095, eta: 0.89, heatPump: true },
  { id: 'born-58',        name: 'Cupra Born (58 kWh)',           usableKwh: 58.0, massKg: 1809, cd: 0.270, areaM2: 2.36, crr: 0.0095, eta: 0.88, heatPump: false },
  { id: 'tavascan',       name: 'Cupra Tavascan (77 kWh)',       usableKwh: 77.0, massKg: 2159, cd: 0.260, areaM2: 2.55, crr: 0.0100, eta: 0.88, heatPump: true },
  { id: 'q4-35',          name: 'Audi Q4 e-tron 35',             usableKwh: 52.0, massKg: 1965, cd: 0.280, areaM2: 2.60, crr: 0.0100, eta: 0.88, heatPump: true },
  { id: 'q6-etron',       name: 'Audi Q6 e-tron',                usableKwh: 94.9, massKg: 2340, cd: 0.280, areaM2: 2.70, crr: 0.0105, eta: 0.90, heatPump: true },
  { id: 'q8-etron-55',    name: 'Audi Q8 e-tron 55',             usableKwh: 106.0, massKg: 2585, cd: 0.270, areaM2: 2.79, crr: 0.0110, eta: 0.88, heatPump: true },
  { id: 'etron-gt',       name: 'Audi e-tron GT quattro',        usableKwh: 83.7, massKg: 2280, cd: 0.240, areaM2: 2.35, crr: 0.0100, eta: 0.90, heatPump: true },
  { id: 'a6-etron',       name: 'Audi A6 e-tron',                usableKwh: 94.9, massKg: 2230, cd: 0.210, areaM2: 2.40, crr: 0.0095, eta: 0.90, heatPump: true },
  { id: 'taycan-base',    name: 'Porsche Taycan (base)',         usableKwh: 79.2, massKg: 2130, cd: 0.220, areaM2: 2.33, crr: 0.0100, eta: 0.90, heatPump: true },
  { id: 'taycan-turbo',   name: 'Porsche Taycan Turbo',          usableKwh: 83.7, massKg: 2305, cd: 0.220, areaM2: 2.33, crr: 0.0105, eta: 0.90, heatPump: true },
  { id: 'macan-4',        name: 'Porsche Macan 4 Electric',      usableKwh: 95.0, massKg: 2405, cd: 0.260, areaM2: 2.65, crr: 0.0105, eta: 0.90, heatPump: true },

  // ---- BMW / MINI ----
  { id: 'i4-m50',         name: 'BMW i4 M50',                    usableKwh: 81.5, massKg: 2215, cd: 0.260, areaM2: 2.36, crr: 0.0105, eta: 0.89, heatPump: true },
  { id: 'i5-40',          name: 'BMW i5 eDrive40',               usableKwh: 81.2, massKg: 2200, cd: 0.230, areaM2: 2.42, crr: 0.0095, eta: 0.90, heatPump: true },
  { id: 'i7-60',          name: 'BMW i7 xDrive60',               usableKwh: 101.7, massKg: 2640, cd: 0.240, areaM2: 2.60, crr: 0.0105, eta: 0.90, heatPump: true },
  { id: 'ix1-30',         name: 'BMW iX1 xDrive30',              usableKwh: 64.7, massKg: 2010, cd: 0.280, areaM2: 2.52, crr: 0.0100, eta: 0.89, heatPump: true },
  { id: 'ix3-2026',       name: 'BMW iX3 (Neue Klasse)',         usableKwh: 108.7, massKg: 2285, cd: 0.240, areaM2: 2.60, crr: 0.0095, eta: 0.91, heatPump: true },
  { id: 'ix-40',          name: 'BMW iX xDrive40',               usableKwh: 71.0, massKg: 2365, cd: 0.250, areaM2: 2.72, crr: 0.0105, eta: 0.90, heatPump: true },
  { id: 'i3-120',         name: 'BMW i3 120Ah',                  usableKwh: 37.9, massKg: 1345, cd: 0.290, areaM2: 2.38, crr: 0.0090, eta: 0.88, heatPump: true },
  { id: 'mini-se',        name: 'MINI Cooper SE (54 kWh)',       usableKwh: 49.2, massKg: 1615, cd: 0.280, areaM2: 2.20, crr: 0.0095, eta: 0.88, heatPump: true },
  { id: 'mini-countryman-e', name: 'MINI Countryman E',          usableKwh: 64.7, massKg: 2005, cd: 0.260, areaM2: 2.50, crr: 0.0100, eta: 0.89, heatPump: true },

  // ---- Mercedes-Benz / Smart ----
  { id: 'eqa-250',        name: 'Mercedes EQA 250',              usableKwh: 66.5, massKg: 2040, cd: 0.280, areaM2: 2.52, crr: 0.0100, eta: 0.88, heatPump: true },
  { id: 'eqc-400',        name: 'Mercedes EQC 400',              usableKwh: 80.0, massKg: 2495, cd: 0.280, areaM2: 2.65, crr: 0.0110, eta: 0.87, heatPump: false },
  { id: 'eqe-350',        name: 'Mercedes EQE 350+',             usableKwh: 89.0, massKg: 2355, cd: 0.220, areaM2: 2.47, crr: 0.0095, eta: 0.90, heatPump: true },
  { id: 'eqs-450',        name: 'Mercedes EQS 450+',             usableKwh: 107.8, massKg: 2480, cd: 0.200, areaM2: 2.51, crr: 0.0095, eta: 0.91, heatPump: true },
  { id: 'eqe-suv-350',    name: 'Mercedes EQE SUV 350+',         usableKwh: 89.0, massKg: 2540, cd: 0.250, areaM2: 2.75, crr: 0.0105, eta: 0.89, heatPump: true },
  { id: 'cla-ev',         name: 'Mercedes CLA with EQ Technology', usableKwh: 85.0, massKg: 2055, cd: 0.210, areaM2: 2.35, crr: 0.0090, eta: 0.92, heatPump: true },
  { id: 'smart-1',        name: 'Smart #1',                      usableKwh: 62.0, massKg: 1820, cd: 0.290, areaM2: 2.50, crr: 0.0100, eta: 0.88, heatPump: true },
  { id: 'smart-3',        name: 'Smart #3',                      usableKwh: 62.0, massKg: 1810, cd: 0.270, areaM2: 2.45, crr: 0.0095, eta: 0.88, heatPump: true },

  // ---- Volvo / Polestar ----
  { id: 'ex30-sr',        name: 'Volvo EX30 Single Motor',       usableKwh: 49.0, massKg: 1755, cd: 0.280, areaM2: 2.40, crr: 0.0095, eta: 0.89, heatPump: true },
  { id: 'ex40',           name: 'Volvo EX40 (XC40 Recharge)',    usableKwh: 78.0, massKg: 2130, cd: 0.329, areaM2: 2.56, crr: 0.0105, eta: 0.88, heatPump: true },
  { id: 'ec40',           name: 'Volvo EC40 (C40 Recharge)',     usableKwh: 78.0, massKg: 2120, cd: 0.320, areaM2: 2.50, crr: 0.0105, eta: 0.88, heatPump: true },
  { id: 'ex90',           name: 'Volvo EX90 Twin Motor',         usableKwh: 107.0, massKg: 2818, cd: 0.290, areaM2: 2.95, crr: 0.0110, eta: 0.89, heatPump: true },
  { id: 'polestar2-sr',   name: 'Polestar 2 Standard Range',     usableKwh: 67.0, massKg: 1940, cd: 0.278, areaM2: 2.32, crr: 0.0095, eta: 0.89, heatPump: true },
  { id: 'polestar3',      name: 'Polestar 3 Long Range',         usableKwh: 107.0, massKg: 2584, cd: 0.290, areaM2: 2.85, crr: 0.0110, eta: 0.89, heatPump: true },
  { id: 'polestar4',      name: 'Polestar 4 Long Range',         usableKwh: 94.0, massKg: 2230, cd: 0.269, areaM2: 2.62, crr: 0.0100, eta: 0.90, heatPump: true },

  // ---- Ford / GM / Stellantis (North America) ----
  { id: 'machE-sr',       name: 'Ford Mustang Mach-E SR RWD',    usableKwh: 68.0, massKg: 1993, cd: 0.290, areaM2: 2.55, crr: 0.0100, eta: 0.89, heatPump: false },
  { id: 'machE-gt',       name: 'Ford Mustang Mach-E GT',        usableKwh: 88.0, massKg: 2273, cd: 0.300, areaM2: 2.57, crr: 0.0110, eta: 0.88, heatPump: false },
  { id: 'f150-lightning-er', name: 'Ford F-150 Lightning ER',    usableKwh: 131.0, massKg: 2985, cd: 0.440, areaM2: 3.65, crr: 0.0120, eta: 0.88, heatPump: false },
  { id: 'explorer-ev',    name: 'Ford Explorer EV (77 kWh)',     usableKwh: 77.0, massKg: 2142, cd: 0.290, areaM2: 2.60, crr: 0.0100, eta: 0.88, heatPump: true },
  { id: 'bolt-euv',       name: 'Chevrolet Bolt EUV',            usableKwh: 62.0, massKg: 1669, cd: 0.320, areaM2: 2.55, crr: 0.0100, eta: 0.87, heatPump: false },
  { id: 'equinox-ev',     name: 'Chevrolet Equinox EV LT',       usableKwh: 85.0, massKg: 2190, cd: 0.300, areaM2: 2.70, crr: 0.0105, eta: 0.89, heatPump: true },
  { id: 'blazer-ev',      name: 'Chevrolet Blazer EV RS',        usableKwh: 85.0, massKg: 2470, cd: 0.300, areaM2: 2.80, crr: 0.0110, eta: 0.89, heatPump: true },
  { id: 'silverado-ev',   name: 'Chevrolet Silverado EV RST',    usableKwh: 205.0, massKg: 4200, cd: 0.400, areaM2: 3.70, crr: 0.0125, eta: 0.88, heatPump: true },
  { id: 'lyriq',          name: 'Cadillac Lyriq',                usableKwh: 102.0, massKg: 2660, cd: 0.300, areaM2: 2.85, crr: 0.0110, eta: 0.89, heatPump: true },
  { id: 'hummer-ev',      name: 'GMC Hummer EV Pickup',          usableKwh: 205.0, massKg: 4100, cd: 0.500, areaM2: 4.00, crr: 0.0135, eta: 0.87, heatPump: true },
  { id: 'jeep-avenger',   name: 'Jeep Avenger Electric',         usableKwh: 51.0, massKg: 1585, cd: 0.320, areaM2: 2.40, crr: 0.0100, eta: 0.88, heatPump: true },
  { id: 'corsa-e',        name: 'Opel/Vauxhall Corsa Electric',  usableKwh: 46.0, massKg: 1530, cd: 0.290, areaM2: 2.20, crr: 0.0095, eta: 0.88, heatPump: true },
  { id: 'mokka-e',        name: 'Opel/Vauxhall Mokka Electric',  usableKwh: 46.0, massKg: 1598, cd: 0.320, areaM2: 2.35, crr: 0.0100, eta: 0.88, heatPump: true },
  { id: 'e-c4',           name: 'Citroen e-C4 (50 kWh)',         usableKwh: 46.0, massKg: 1616, cd: 0.300, areaM2: 2.35, crr: 0.0100, eta: 0.88, heatPump: true },
  { id: 'e-2008',         name: 'Peugeot e-2008 (50 kWh)',       usableKwh: 46.0, massKg: 1593, cd: 0.320, areaM2: 2.35, crr: 0.0100, eta: 0.88, heatPump: true },
  { id: 'e-3008',         name: 'Peugeot e-3008 (73 kWh)',       usableKwh: 73.0, massKg: 2183, cd: 0.280, areaM2: 2.55, crr: 0.0100, eta: 0.89, heatPump: true },
  { id: 'ds3-crossback-e', name: 'DS 3 E-Tense',                 usableKwh: 46.0, massKg: 1567, cd: 0.310, areaM2: 2.30, crr: 0.0095, eta: 0.88, heatPump: true },
  { id: 'fiat600e',       name: 'Fiat 600e',                     usableKwh: 51.0, massKg: 1590, cd: 0.310, areaM2: 2.35, crr: 0.0100, eta: 0.88, heatPump: true },
  { id: 'abarth500e',     name: 'Abarth 500e',                   usableKwh: 37.3, massKg: 1410, cd: 0.310, areaM2: 2.15, crr: 0.0100, eta: 0.88, heatPump: true },

  // ---- Renault / Dacia ----
  { id: 'megane-etech',   name: 'Renault Megane E-Tech EV60',    usableKwh: 60.0, massKg: 1636, cd: 0.290, areaM2: 2.40, crr: 0.0095, eta: 0.89, heatPump: true },
  { id: 'scenic-etech',   name: 'Renault Scenic E-Tech (87 kWh)', usableKwh: 87.0, massKg: 1890, cd: 0.274, areaM2: 2.50, crr: 0.0095, eta: 0.89, heatPump: true },
  { id: 'r5-etech',       name: 'Renault 5 E-Tech (52 kWh)',     usableKwh: 52.0, massKg: 1450, cd: 0.310, areaM2: 2.25, crr: 0.0095, eta: 0.89, heatPump: true },
  { id: 'dacia-spring',   name: 'Dacia Spring (26.8 kWh)',       usableKwh: 26.8, massKg: 984,  cd: 0.350, areaM2: 2.20, crr: 0.0100, eta: 0.86, heatPump: false },
  { id: 'zoe-r110',       name: 'Renault Zoe R110 (41 kWh)',     usableKwh: 41.0, massKg: 1480, cd: 0.310, areaM2: 2.30, crr: 0.0095, eta: 0.87, heatPump: false },

  // ---- Nissan / Toyota / Honda / Mazda / Subaru / Lexus ----
  { id: 'ariya-63',       name: 'Nissan Ariya (63 kWh)',         usableKwh: 63.0, massKg: 1880, cd: 0.297, areaM2: 2.55, crr: 0.0100, eta: 0.89, heatPump: true },
  { id: 'ariya-87',       name: 'Nissan Ariya (87 kWh)',         usableKwh: 87.0, massKg: 2070, cd: 0.297, areaM2: 2.55, crr: 0.0100, eta: 0.89, heatPump: true },
  { id: 'bz4x',           name: 'Toyota bZ4X FWD',               usableKwh: 64.0, massKg: 1965, cd: 0.290, areaM2: 2.58, crr: 0.0100, eta: 0.88, heatPump: true },
  { id: 'urban-cruiser',  name: 'Toyota Urban Cruiser BEV',      usableKwh: 61.0, massKg: 1800, cd: 0.300, areaM2: 2.50, crr: 0.0100, eta: 0.88, heatPump: true },
  { id: 'solterra',       name: 'Subaru Solterra AWD',           usableKwh: 64.0, massKg: 2020, cd: 0.290, areaM2: 2.58, crr: 0.0105, eta: 0.88, heatPump: true },
  { id: 'lexus-rz450e',   name: 'Lexus RZ 450e',                 usableKwh: 64.0, massKg: 2100, cd: 0.290, areaM2: 2.58, crr: 0.0105, eta: 0.88, heatPump: true },
  { id: 'honda-eny1',     name: 'Honda e:Ny1',                   usableKwh: 61.9, massKg: 1730, cd: 0.310, areaM2: 2.45, crr: 0.0100, eta: 0.88, heatPump: true },
  { id: 'honda-prologue', name: 'Honda Prologue',                usableKwh: 85.0, massKg: 2540, cd: 0.300, areaM2: 2.80, crr: 0.0110, eta: 0.89, heatPump: true },
  { id: 'mazda-mx30',     name: 'Mazda MX-30',                   usableKwh: 30.0, massKg: 1720, cd: 0.310, areaM2: 2.45, crr: 0.0100, eta: 0.87, heatPump: true },

  // ---- Jaguar / Lucid / Rivian / Fisker ----
  { id: 'ipace',          name: 'Jaguar I-Pace EV400',           usableKwh: 84.7, massKg: 2208, cd: 0.290, areaM2: 2.62, crr: 0.0105, eta: 0.87, heatPump: true },
  { id: 'lucid-air-pure', name: 'Lucid Air Pure RWD',            usableKwh: 84.0, massKg: 2085, cd: 0.197, areaM2: 2.42, crr: 0.0090, eta: 0.92, heatPump: true },
  { id: 'lucid-air-gt',   name: 'Lucid Air Grand Touring',       usableKwh: 112.0, massKg: 2360, cd: 0.210, areaM2: 2.42, crr: 0.0095, eta: 0.92, heatPump: true },
  { id: 'r1s-large',      name: 'Rivian R1S (Large Pack)',       usableKwh: 135.0, massKg: 3060, cd: 0.330, areaM2: 3.35, crr: 0.0115, eta: 0.89, heatPump: true },
  { id: 'r1t-max',        name: 'Rivian R1T (Max Pack)',         usableKwh: 149.0, massKg: 3300, cd: 0.300, areaM2: 3.40, crr: 0.0115, eta: 0.89, heatPump: true },
  { id: 'fisker-ocean',   name: 'Fisker Ocean Extreme',          usableKwh: 106.0, massKg: 2410, cd: 0.270, areaM2: 2.70, crr: 0.0105, eta: 0.88, heatPump: true },

  // ---- MG / BYD / Chinese brands ----
  { id: 'mg4-51',         name: 'MG4 Standard (51 kWh)',         usableKwh: 50.8, massKg: 1635, cd: 0.270, areaM2: 2.35, crr: 0.0095, eta: 0.88, heatPump: false },
  { id: 'mg-zs-ev',       name: 'MG ZS EV Long Range',           usableKwh: 68.3, massKg: 1620, cd: 0.310, areaM2: 2.50, crr: 0.0100, eta: 0.88, heatPump: false },
  { id: 'mg5-ev',         name: 'MG5 EV Long Range',             usableKwh: 57.4, massKg: 1585, cd: 0.270, areaM2: 2.35, crr: 0.0095, eta: 0.88, heatPump: false },
  { id: 'mg-marvel-r',    name: 'MG Marvel R',                   usableKwh: 70.0, massKg: 1905, cd: 0.290, areaM2: 2.55, crr: 0.0100, eta: 0.88, heatPump: false },
  { id: 'byd-dolphin',    name: 'BYD Dolphin (60 kWh)',          usableKwh: 60.4, massKg: 1658, cd: 0.290, areaM2: 2.40, crr: 0.0095, eta: 0.88, heatPump: true },
  { id: 'byd-seal',       name: 'BYD Seal (82 kWh)',             usableKwh: 82.5, massKg: 2055, cd: 0.219, areaM2: 2.35, crr: 0.0095, eta: 0.89, heatPump: true },
  { id: 'byd-sealion7',   name: 'BYD Sealion 7',                 usableKwh: 82.5, massKg: 2225, cd: 0.270, areaM2: 2.62, crr: 0.0100, eta: 0.89, heatPump: true },
  { id: 'byd-han',        name: 'BYD Han EV',                    usableKwh: 85.4, massKg: 2200, cd: 0.233, areaM2: 2.45, crr: 0.0100, eta: 0.89, heatPump: true },
  { id: 'byd-tang',       name: 'BYD Tang EV',                   usableKwh: 108.8, massKg: 2620, cd: 0.290, areaM2: 2.95, crr: 0.0110, eta: 0.88, heatPump: true },
  { id: 'ora-funky-cat',  name: 'Ora 03 / Funky Cat (63 kWh)',   usableKwh: 63.1, massKg: 1595, cd: 0.320, areaM2: 2.35, crr: 0.0100, eta: 0.87, heatPump: false },
  { id: 'xpeng-g6',       name: 'XPeng G6 Long Range',           usableKwh: 87.5, massKg: 2010, cd: 0.248, areaM2: 2.60, crr: 0.0100, eta: 0.90, heatPump: true },
  { id: 'xpeng-p7',       name: 'XPeng P7',                      usableKwh: 82.7, massKg: 2050, cd: 0.236, areaM2: 2.40, crr: 0.0095, eta: 0.90, heatPump: true },
  { id: 'nio-et5',        name: 'NIO ET5 (75 kWh)',              usableKwh: 75.0, massKg: 2165, cd: 0.240, areaM2: 2.40, crr: 0.0100, eta: 0.89, heatPump: true },
  { id: 'nio-et7',        name: 'NIO ET7 (100 kWh)',             usableKwh: 100.0, massKg: 2380, cd: 0.208, areaM2: 2.45, crr: 0.0100, eta: 0.89, heatPump: true },
  { id: 'nio-es6',        name: 'NIO ES6 (100 kWh)',             usableKwh: 100.0, massKg: 2385, cd: 0.260, areaM2: 2.75, crr: 0.0105, eta: 0.89, heatPump: true },
  { id: 'zeekr-001',      name: 'Zeekr 001 (100 kWh)',           usableKwh: 100.0, massKg: 2340, cd: 0.230, areaM2: 2.60, crr: 0.0100, eta: 0.90, heatPump: true },
  { id: 'zeekr-x',        name: 'Zeekr X',                       usableKwh: 66.0, massKg: 1900, cd: 0.280, areaM2: 2.45, crr: 0.0100, eta: 0.89, heatPump: true },
  { id: 'leapmotor-c10',  name: 'Leapmotor C10',                 usableKwh: 69.9, massKg: 1980, cd: 0.280, areaM2: 2.60, crr: 0.0100, eta: 0.88, heatPump: true },
  { id: 'vinfast-vf8',    name: 'VinFast VF 8 Eco',              usableKwh: 82.0, massKg: 2350, cd: 0.290, areaM2: 2.70, crr: 0.0110, eta: 0.87, heatPump: false },
];

/**
 * A sensible "average modern EV" used as the starting point when the user
 * picks "Other / custom". They can then override the numbers they know.
 */
export const CUSTOM_CAR_DEFAULTS = {
  id: 'custom',
  name: 'Custom vehicle',
  usableKwh: 60.0,
  massKg: 1900,
  cd: 0.280,
  areaM2: 2.50,
  crr: 0.0100,
  eta: 0.89,
  heatPump: true,
};

/** Look up a car by id. Returns undefined for 'custom'. */
export function findCar(id) {
  return CARS.find((c) => c.id === id);
}
