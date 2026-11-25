# North America DOT & Transportation Coverage (`DOT_COVERAGE.md`)

Machine-readable registry: [assets/dot-provider-registry.json](assets/dot-provider-registry.json)

## Coverage Summary (71 Jurisdictions)

- **Tier 1 — Full Live Incidents & Closures (Native In-Map):** 6 (CA, OR, WA, TN, BC, QC)
- **Tier 1 — Live Construction & Work Zones (Native WZDx In-Map):** 18 (AZ, DE, FL, IA, ID, IN, KS, KY, LA, MD, MN, MO, MS, ND, NJ, OK, SD, WI)
- **Tier 2 — Official ArcGIS MapServer / Freight GIS Overlay:** 2 (AL, TX)
- **Tier 3 — Embedded In-App Official DOT Viewer:** Enabled for embed-permitted portals (e.g., Alabama ALGO Traffic) with automatic fallback to Tier 4 External Browser
- **Free Registration Developer APIs Ready for Cloudflare Worker Secrets:** 13 (CO, TX, OH, VA, MA, IL, PA, WY, NC, NY, AL, AB, ON)

> **Coverage Honesty Policy:** Route Weather never represents unavailable traffic data as an absence of hazards. Jurisdictions without live in-map incident feeds explicitly display *"Live traffic incidents unavailable in-map — check official DOT portal."*

## Authorized Access Request Template — Alabama (ALDOT / ALGO Traffic)

To request authorized live incident/camera feed access under **23 CFR Part 511**, email **`algodeveloper@dot.state.al.us`**:

```text
Subject: Authorized ALGO Traffic Developer Feed Access Request — Route Weather (Andy's Dev Studio)

Hello ALGO Traffic Developer Team,

I am the developer of Route Weather (by Andy's Dev Studio), a highway weather and traveler-safety navigation app for everyday motorists and commercial drivers.

We currently integrate ALDOT's public ArcGIS road network services and link drivers directly to algotraffic.com. Under 23 CFR Part 511 real-time traveler information sharing, we would like to request authorized developer access (API key or WZDx/Open511 feed) to display official ALDOT incidents, construction closures, and camera snapshots with full attribution to ALDOT / ALGO Traffic.

Please let us know the registration process, rate limits, and attribution terms.

Thank you,
Andy's Dev Studio
```

## Free Registration API Keys (Cloudflare Worker Secrets)

Drop any free developer key into Cloudflare Worker secrets (`wrangler secret put <SECRET_NAME>`) — `/app-api/dot-feed?code=<CODE>` automatically upgrades that jurisdiction to Tier 1 native in-map data without an app rebuild:

| Code | Jurisdiction | Worker Secret | Standard | Registration Portal |
|---|---|---|---|---|
| `AL` | Alabama | `ALGO_API_KEY` | rest | mailto:algodeveloper@dot.state.al.us |
| `CO` | Colorado | `COTRIP_API_KEY` | cwz | https://data.cotrip.org/ |
| `IL` | Illinois | `IL_CWZ_API_KEY` | cwz | https://www.gettingaroundillinois.com/ |
| `MA` | Massachusetts | `MASSDOT_API_KEY` | cwz | https://www.mass.gov/info-details/highway-data-for-developers |
| `NY` | New York | `NY511_API_KEY` | wzdx | https://511ny.org/developers/help |
| `NC` | North Carolina | `DRIVENC_API_KEY` | wzdx | https://drivenc.gov/ |
| `OH` | Ohio | `OHGO_API_KEY` | wzdx | https://publicapi.ohgo.com/ |
| `PA` | Pennsylvania | `PA_TURNPIKE_API_KEY` | wzdx | https://www.511pa.com/ |
| `TX` | Texas | `DRIVETEXAS_API_KEY` | wzdx | https://drivetexas.org/ |
| `VA` | Virginia | `VDOT_API_KEY` | wzdx | https://www.virginiadot.org/travel/511.asp |
| `WY` | Wyoming | `WYDOT_API_KEY` | cwz | https://www.wyoroad.info/ |
| `CA-AB` | Alberta | `AB511_API_KEY` | 511_v2 | https://511.alberta.ca/developers/doc |
| `CA-ON` | Ontario | `ON511_API_KEY` | 511_v2 | https://511on.ca/developers/doc |

## Full Jurisdiction Matrix

### United States

| Code | Jurisdiction | Highest Tier | Live Conditions | Commercial / GIS Layers | Official Portal |
|---|---|---|---|---|---|
| `AL` | Alabama | Tier 2 | Live traffic via official website | Low Clearances, GIS: ALDOT Highway & Construction Network, Alabama Code § 32-9-20 (Size & Weight) | [ALGO Traffic](https://algotraffic.com/) |
| `AK` | Alaska | Tier 4 | Live traffic via official website | Low Clearances, Tolls | [Alaska 511](https://511.alaska.gov/) |
| `AZ` | Arizona | Tier 1 | Live construction & work zones (WZDx) | Low Clearances | [AZ511](https://www.az511.gov/) |
| `AR` | Arkansas | Tier 4 | Live traffic via official website | Low Clearances | [IDrive Arkansas](https://www.idrivearkansas.com/) |
| `CA` | California | Tier 1 | Full live incidents, closures & conditions | Low Clearances, Tolls | [Caltrans QuickMap](https://quickmap.dot.ca.gov/) |
| `CO` | Colorado | Tier 4 | Live traffic via official website | Low Clearances, Tolls | [COtrip](https://www.cotrip.org/) |
| `CT` | Connecticut | Tier 4 | Live traffic via official website | Low Clearances | [CTroads](https://ctroads.org/) |
| `DE` | Delaware | Tier 1 | Live construction & work zones (WZDx) | Low Clearances, Tolls | [DelDOT Interactive Maps](https://deldot.gov/map/) |
| `DC` | District of Columbia | Tier 4 | Live traffic via official website | Low Clearances | [DDOT Traffic Advisories](https://ddot.dc.gov/newsroom/advisories) |
| `FL` | Florida | Tier 1 | Live construction & work zones (WZDx) | Low Clearances, Tolls | [Florida 511](https://fl511.com/) |
| `GA` | Georgia | Tier 4 | Live traffic via official website | Low Clearances, Tolls | [Georgia 511](https://511ga.org/) |
| `HI` | Hawaii | Tier 4 | Live traffic via official website | Low Clearances | [GoAkamai](https://www.goakamai.org/) |
| `ID` | Idaho | Tier 1 | Live construction & work zones (WZDx) | Low Clearances | [Idaho 511](https://511.idaho.gov/) |
| `IL` | Illinois | Tier 4 | Live traffic via official website | Low Clearances, Tolls | [Getting Around Illinois](https://www.gettingaroundillinois.com/) |
| `IN` | Indiana | Tier 1 | Live construction & work zones (WZDx) | Low Clearances, Tolls | [Indiana 511](https://511in.org/) |
| `IA` | Iowa | Tier 1 | Live construction & work zones (WZDx) | Low Clearances, Tolls | [Iowa 511](https://www.511ia.org/) |
| `KS` | Kansas | Tier 1 | Live construction & work zones (WZDx) | Low Clearances, Tolls | [KanDrive](https://www.kandrive.gov/) |
| `KY` | Kentucky | Tier 1 | Live construction & work zones (WZDx) | Low Clearances, Tolls | [GoKY](https://goky.ky.gov/) |
| `LA` | Louisiana | Tier 1 | Live construction & work zones (WZDx) | Low Clearances, Tolls | [Louisiana 511](https://www.511la.org/) |
| `ME` | Maine | Tier 4 | Live traffic via official website | Low Clearances, Tolls | [New England 511](https://newengland511.org/) |
| `MD` | Maryland | Tier 1 | Live construction & work zones (WZDx) | Low Clearances, Tolls | [Maryland CHART](https://chart.maryland.gov/) |
| `MA` | Massachusetts | Tier 4 | Live traffic via official website | Low Clearances, Tolls | [Mass511](https://mass511.com/) |
| `MI` | Michigan | Tier 4 | Live traffic via official website | Low Clearances, Tolls | [Mi Drive](https://mdotjboss.state.mi.us/MiDrive/map) |
| `MN` | Minnesota | Tier 1 | Live construction & work zones (WZDx) | Low Clearances, Tolls | [Minnesota 511](https://511mn.org/) |
| `MS` | Mississippi | Tier 1 | Live construction & work zones (WZDx) | Low Clearances | [MDOT Traffic](https://www.mdottraffic.com/) |
| `MO` | Missouri | Tier 1 | Live construction & work zones (WZDx) | Low Clearances | [MoDOT Traveler Information Map](https://traveler.modot.org/map/) |
| `MT` | Montana | Tier 4 | Live traffic via official website | Low Clearances | [Montana 511](https://www.511mt.net/) |
| `NE` | Nebraska | Tier 4 | Live traffic via official website | Low Clearances, Tolls | [Nebraska 511](https://www.511.nebraska.gov/) |
| `NV` | Nevada | Tier 4 | Live traffic via official website | Low Clearances, Tolls | [Nevada 511](https://www.nvroads.com/) |
| `NH` | New Hampshire | Tier 4 | Live traffic via official website | Low Clearances, Tolls | [New England 511](https://newengland511.org/) |
| `NJ` | New Jersey | Tier 1 | Live construction & work zones (WZDx) | Low Clearances, Tolls | [511NJ](https://www.511nj.org/) |
| `NM` | New Mexico | Tier 4 | Live traffic via official website | Low Clearances | [NMRoads](https://www.nmroads.com/) |
| `NY` | New York | Tier 4 | Live traffic via official website | Low Clearances, Tolls | [511NY](https://511ny.org/) |
| `NC` | North Carolina | Tier 4 | Live traffic via official website | Low Clearances, Tolls | [DriveNC](https://drivenc.gov/) |
| `ND` | North Dakota | Tier 1 | Live construction & work zones (WZDx) | Low Clearances | [ND Roads](https://travel.dot.nd.gov/) |
| `OH` | Ohio | Tier 4 | Live traffic via official website | Low Clearances, Tolls | [OHGO](https://www.ohgo.com/) |
| `OK` | Oklahoma | Tier 1 | Live construction & work zones (WZDx) | Low Clearances, Tolls | [OK Traffic](https://www.oktraffic.org/#/map?area=statewide) |
| `OR` | Oregon | Tier 1 | Full live incidents, closures & conditions | Low Clearances | [TripCheck](https://www.tripcheck.com/) |
| `PA` | Pennsylvania | Tier 4 | Live traffic via official website | Low Clearances, Tolls | [511PA](https://www.511pa.com/) |
| `PR` | Puerto Rico | Tier 4 | Live traffic via official website | Tolls | [Puerto Rico Traveler Information](https://its.act.pr.gov/es/Default.aspx) |
| `RI` | Rhode Island | Tier 4 | Live traffic via official website | Low Clearances, Tolls | [RIDOT Traveler Information](https://www.dot.ri.gov/travel/) |
| `SC` | South Carolina | Tier 4 | Live traffic via official website | Low Clearances | [South Carolina 511](https://www.511sc.org/) |
| `SD` | South Dakota | Tier 1 | Live construction & work zones (WZDx) | Low Clearances | [South Dakota 511](https://www.sd511.org/) |
| `TN` | Tennessee | Tier 1 | Full live incidents, closures & conditions | Low Clearances | [TDOT SmartWay](https://smartway.tn.gov/traffic) |
| `TX` | Texas | Tier 2 | Live traffic via official website | Low Clearances, Tolls, GIS: TxDOT Highway Freight Network | [DriveTexas](https://drivetexas.org/) |
| `UT` | Utah | Tier 4 | Live traffic via official website | Low Clearances, Tolls | [UDOT Traffic](https://www.udottraffic.utah.gov/) |
| `VT` | Vermont | Tier 4 | Live traffic via official website | Low Clearances, Tolls | [New England 511](https://newengland511.org/) |
| `VA` | Virginia | Tier 4 | Live traffic via official website | Low Clearances | [VDOT 511](https://511.vdot.virginia.gov/) |
| `WA` | Washington | Tier 1 | Full live incidents, closures & conditions | Low Clearances, Tolls | [WSDOT Real-Time Travel Map](https://wsdot.com/travel/real-time/roadconditions) |
| `WV` | West Virginia | Tier 4 | Live traffic via official website | Low Clearances | [West Virginia 511](https://wv511.org/) |
| `WI` | Wisconsin | Tier 1 | Live construction & work zones (WZDx) | Low Clearances | [511 Wisconsin](https://511wi.gov/) |
| `WY` | Wyoming | Tier 4 | Live traffic via official website | Low Clearances | [WYDOT Road Conditions Map](https://map.wyoroad.info/) |

### Canada

| Code | Jurisdiction | Highest Tier | Live Conditions | Commercial / GIS Layers | Official Portal |
|---|---|---|---|---|---|
| `CA-AB` | Alberta | Tier 4 | Official DOT portal | — | [511 Alberta](https://511.alberta.ca/) |
| `CA-BC` | British Columbia | Tier 1 | Full live incidents & closures | — | [DriveBC](https://www.drivebc.ca/) |
| `CA-MB` | Manitoba | Tier 4 | Official DOT portal | — | [Manitoba 511](https://www.manitoba511.ca/) |
| `CA-NB` | New Brunswick | Tier 4 | Official DOT portal | — | [NB 511](https://511.gnb.ca/) |
| `CA-NL` | Newfoundland & Labrador | Tier 4 | Official DOT portal | — | [NL 511](https://511nl.ca/) |
| `CA-NT` | Northwest Territories | Tier 4 | Official DOT portal | — | [NWT Highway Conditions](https://www.inf.gov.nt.ca/en/highways) |
| `CA-NS` | Nova Scotia | Tier 4 | Official DOT portal | — | [Nova Scotia 511](https://511.novascotia.ca/) |
| `CA-NU` | Nunavut | Tier 4 | Official DOT portal | — | [Nunavut Transportation](https://gov.nu.ca/) |
| `CA-ON` | Ontario | Tier 4 | Official DOT portal | — | [Ontario 511](https://511on.ca/) |
| `CA-PE` | Prince Edward Island | Tier 4 | Official DOT portal | — | [PEI 511](https://511.gov.pe.ca/) |
| `CA-QC` | Québec | Tier 1 | Full live incidents & closures | — | [Québec 511](https://www.quebec511.info/) |
| `CA-SK` | Saskatchewan | Tier 4 | Official DOT portal | — | [Highway Hotline](https://hotline.gov.sk.ca/) |
| `CA-YT` | Yukon | Tier 4 | Official DOT portal | — | [Yukon 511](https://511yukon.ca/) |

### Mexico

| Code | Jurisdiction | Highest Tier | Live Conditions | Commercial / GIS Layers | Official Portal |
|---|---|---|---|---|---|
| `MX-BCN` | Baja California (La Rumorosa) | Tier 4 | Official DOT portal | — | [FIARUM](https://www.fiarum.gob.mx/) |
| `MX-GN` | Highway Patrol Alerts | Tier 4 | Official DOT portal | — | [Guardia Nacional Carreteras](https://x.com/GN_Carreteras) |
| `MX-SICT` | Mexico Federal Highways | Tier 4 | Official DOT portal | — | [SICT](https://www.gob.mx/sct) |
| `MX-CAPUFE` | Mexico Toll Highways (Federal) | Tier 4 | Official DOT portal | — | [CAPUFE](https://www.gob.mx/capufe) |
| `MX-NL` | Nuevo León & Northeast | Tier 4 | Official DOT portal | — | [CAPUFE Noreste](https://www.gob.mx/capufe) |
| `MX-SON` | Sonora (Mex-15 Corridor) | Tier 4 | Official DOT portal | — | [CAPUFE Noroeste](https://www.gob.mx/capufe) |

