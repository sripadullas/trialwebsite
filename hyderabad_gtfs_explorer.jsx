import React, { useEffect, useMemo, useRef, useState } from "react";
import JSZip from "jszip";
import Papa from "papaparse";
import { Search, Bus, MapPinned, Moon, Sun, Upload, Route, Layers, Info, X } from "lucide-react";
import { MapContainer, TileLayer, Polyline, Marker, Popup, useMap } from "react-leaflet";
import L from "leaflet";
import "leaflet/dist/leaflet.css";

// Hyderabad GTFS Explorer
// Upload your GTFS ZIP (TGSRTC / Hyderabad bus feed) and explore routes + stops.

const defaultCenter = [17.385, 78.4867]; // Hyderabad

const stopIcon = new L.DivIcon({
  className: "",
  html: `<div style="width:10px;height:10px;border-radius:9999px;background:#0f172a;border:2px solid white;box-shadow:0 2px 8px rgba(0,0,0,0.25)"></div>`,
  iconSize: [10, 10],
  iconAnchor: [5, 5],
});

function csvToJson(text) {
  return Papa.parse(text, { header: true, skipEmptyLines: true }).data;
}

function parseTimeToSeconds(t) {
  if (!t || typeof t !== "string") return null;
  const [h, m, s] = t.split(":").map(Number);
  return h * 3600 + m * 60 + s;
}

function formatClock(sec) {
  if (sec == null || Number.isNaN(sec)) return "—";
  const h = Math.floor(sec / 3600) % 24;
  const m = Math.floor((sec % 3600) / 60);
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

function fitBounds({ routeStops, selectedStop }) {
  const map = useMap();
  useEffect(() => {
    if (!map) return;
    if (routeStops?.length > 1) {
      const bounds = L.latLngBounds(routeStops.map((s) => [Number(s.stop_lat), Number(s.stop_lon)]));
      map.fitBounds(bounds.pad(0.15));
    } else if (selectedStop) {
      map.flyTo([Number(selectedStop.stop_lat), Number(selectedStop.stop_lon)], 15, { duration: 0.75 });
    }
  }, [map, routeStops, selectedStop]);
  return null;
}

export default function HyderabadGTFSExplorer() {
  const [dark, setDark] = useState(true);
  const [loading, setLoading] = useState(false);
  const [statusText, setStatusText] = useState("Initializing…");
  const [gtfs, setGtfs] = useState(null);
  const [query, setQuery] = useState("");
  const [routeQuery, setRouteQuery] = useState("");
  const [selectedRoute, setSelectedRoute] = useState(null);
  const [selectedStop, setSelectedStop] = useState(null);
  const [showStops, setShowStops] = useState(true);
  const [maxVisibleStops, setMaxVisibleStops] = useState(250);
  const fileRef = useRef(null);

  async function loadZip(file) {
    setStatusText("Loading GTFS feed…");
    setLoading(true);
    try {
      const zip = await JSZip.loadAsync(file);
      const needed = ["stops.txt", "routes.txt", "trips.txt", "stop_times.txt", "calendar.txt"];
      const missing = needed.filter((f) => !zip.file(f));
      if (missing.length) throw new Error(`Missing required GTFS files: ${missing.join(", ")}`);

      const [stopsTxt, routesTxt, tripsTxt, stopTimesTxt, calendarTxt, agencyTxt, feedInfoTxt] = await Promise.all([
        zip.file("stops.txt").async("string"),
        zip.file("routes.txt").async("string"),
        zip.file("trips.txt").async("string"),
        zip.file("stop_times.txt").async("string"),
        zip.file("calendar.txt").async("string"),
        zip.file("agency.txt")?.async("string") ?? Promise.resolve(""),
        zip.file("feed_info.txt")?.async("string") ?? Promise.resolve(""),
      ]);

      const stops = csvToJson(stopsTxt);
      const routes = csvToJson(routesTxt);
      const trips = csvToJson(tripsTxt);
      const stopTimes = csvToJson(stopTimesTxt);
      const calendar = csvToJson(calendarTxt);
      const agency = agencyTxt ? csvToJson(agencyTxt) : [];
      const feedInfo = feedInfoTxt ? csvToJson(feedInfoTxt) : [];

      const stopsById = Object.fromEntries(stops.map((s) => [String(s.stop_id), s]));
      const tripsByRoute = {};
      trips.forEach((t) => {
        const rid = String(t.route_id);
        if (!tripsByRoute[rid]) tripsByRoute[rid] = [];
        tripsByRoute[rid].push(t);
      });

      const stopTimesByTrip = {};
      stopTimes.forEach((st) => {
        const tid = String(st.trip_id);
        if (!stopTimesByTrip[tid]) stopTimesByTrip[tid] = [];
        stopTimesByTrip[tid].push(st);
      });
      Object.values(stopTimesByTrip).forEach((arr) => arr.sort((a, b) => Number(a.stop_sequence) - Number(b.stop_sequence)));

      const enrichedRoutes = routes.map((r) => {
        const rid = String(r.route_id);
        const routeTrips = tripsByRoute[rid] || [];
        const sampleTrip = routeTrips[0];
        const sampleStops = sampleTrip ? (stopTimesByTrip[String(sampleTrip.trip_id)] || []).map((st) => stopsById[String(st.stop_id)]).filter(Boolean) : [];
        return {
          ...r,
          route_id: rid,
          trip_count: routeTrips.length,
          stop_count: sampleStops.length,
          sampleStops,
          sampleTrip,
        };
      });

      const stopRouteMap = {};
      trips.forEach((t) => {
        const rid = String(t.route_id);
        const tid = String(t.trip_id);
        (stopTimesByTrip[tid] || []).forEach((st) => {
          const sid = String(st.stop_id);
          if (!stopRouteMap[sid]) stopRouteMap[sid] = new Set();
          stopRouteMap[sid].add(rid);
        });
      });

      setStatusText("GTFS loaded successfully");
      setGtfs({
        agency,
        feedInfo,
        calendar,
        stops,
        routes: enrichedRoutes,
        trips,
        stopTimesByTrip,
        tripsByRoute,
        stopsById,
        stopRouteMap,
      });
      setSelectedRoute(enrichedRoutes[0] || null);
      setSelectedStop(null);
    } catch (err) {
      setStatusText(`Load failed: ${err.message || "Failed to load GTFS ZIP"}`);
      alert(err.message || "Failed to load GTFS ZIP");
      console.error(err);
    } finally {
      setLoading(false);
    }
  }

  const filteredRoutes = useMemo(() => {
    if (!gtfs) return [];
    return gtfs.routes
      .filter((r) => !routeQuery || String(r.route_long_name || r.route_id).toLowerCase().includes(routeQuery.toLowerCase()))
      .sort((a, b) => String(a.route_long_name).localeCompare(String(b.route_long_name), undefined, { numeric: true }));
  }, [gtfs, routeQuery]);

  const filteredStops = useMemo(() => {
    if (!gtfs) return [];
    return gtfs.stops.filter((s) => !query || String(s.stop_name).toLowerCase().includes(query.toLowerCase())).slice(0, 250);
  }, [gtfs, query]);

  const selectedRouteStops = useMemo(() => selectedRoute?.sampleStops || [], [selectedRoute]);
  const routeStopIds = useMemo(() => new Set(selectedRouteStops.map((s) => String(s.stop_id))), [selectedRouteStops]);
  const routeTripTimes = useMemo(() => {
    if (!gtfs || !selectedRoute?.sampleTrip) return [];
    return gtfs.stopTimesByTrip[String(selectedRoute.sampleTrip.trip_id)] || [];
  }, [gtfs, selectedRoute]);

  useEffect(() => {
    // Public-ready preload from /data/tgsrtc_gtfs.zip
    (async () => {
      try {
        setLoading(true);
        setStatusText("Preloading Hyderabad GTFS…");
        const res = await fetch("/data/tgsrtc_gtfs.zip");
        if (!res.ok) throw new Error("Preloaded GTFS not found. Add it at public/data/tgsrtc_gtfs.zip");
        const blob = await res.blob();
        const file = new File([blob], "tgsrtc_gtfs.zip", { type: "application/zip" });
        await loadZip(file);
      } catch (e) {
        console.warn(e);
        setStatusText("Preload unavailable — upload GTFS ZIP manually or place file in public/data/tgsrtc_gtfs.zip");
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  const theme = dark
    ? "bg-slate-950 text-slate-100"
    : "bg-slate-100 text-slate-900";
  const panel = dark ? "bg-white/5 border-white/10" : "bg-white border-slate-200";
  const input = dark ? "bg-slate-900/70 border-slate-700 text-slate-100" : "bg-white border-slate-300 text-slate-900";

  return (
    <div className={`${theme} min-h-screen w-full`}>
      <div className="flex items-center justify-between px-6 py-4 border-b border-white/10 backdrop-blur sticky top-0 z-[1000] bg-inherit/80">
        <div>
          <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2"><Bus className="w-6 h-6" /> Hyderabad GTFS Explorer</h1>
          <p className="text-sm opacity-70">Public-ready Hyderabad transit explorer with preloaded GTFS support, route search, stop search, and interactive map.</p>
        </div>
        <div className="flex items-center gap-2">
          <a href="https://leafletjs.com/" target="_blank" rel="noreferrer" className="px-4 py-2 rounded-2xl border border-white/10 hover:scale-[1.02] transition hidden md:flex items-center gap-2">Public-ready</a>
          <button onClick={() => fileRef.current?.click()} className="px-4 py-2 rounded-2xl border border-white/10 hover:scale-[1.02] transition flex items-center gap-2">
            <Upload className="w-4 h-4" /> Upload GTFS ZIP
          </button>
          <button onClick={() => setDark(!dark)} className="p-2 rounded-2xl border border-white/10">
            {dark ? <Sun className="w-4 h-4" /> : <Moon className="w-4 h-4" />}
          </button>
          <input ref={fileRef} type="file" accept=".zip" className="hidden" onChange={(e) => e.target.files?.[0] && loadZip(e.target.files[0])} />
        </div>
      </div>

      <div className="grid grid-cols-12 gap-4 p-4">
        <div className="col-span-12 lg:col-span-3 space-y-4">
          <div className={`${panel} rounded-3xl border p-4 shadow-xl`}>
            <div className="flex items-center gap-2 mb-3"><Route className="w-4 h-4" /><h2 className="font-semibold">Routes</h2></div>
            <div className="relative mb-3"><Search className="w-4 h-4 absolute left-3 top-3 opacity-50" /><input value={routeQuery} onChange={(e) => setRouteQuery(e.target.value)} placeholder="Search route no..." className={`${input} w-full rounded-2xl border pl-10 pr-3 py-2`} /></div>
            <div className="max-h-[42vh] overflow-auto space-y-2 pr-1">
              {filteredRoutes.map((route) => (
                <button key={route.route_id} onClick={() => { setSelectedRoute(route); setSelectedStop(null); }} className={`w-full text-left rounded-2xl p-3 border transition ${selectedRoute?.route_id === route.route_id ? "border-cyan-400 bg-cyan-500/10" : "border-white/10 hover:bg-white/5"}`}>
                  <div className="font-semibold">Route {route.route_long_name || route.route_id}</div>
                  <div className="text-xs opacity-70">Trips: {route.trip_count} • Sample stops: {route.stop_count}</div>
                </button>
              ))}
            </div>
          </div>

          <div className={`${panel} rounded-3xl border p-4 shadow-xl`}>
            <div className="flex items-center gap-2 mb-3"><MapPinned className="w-4 h-4" /><h2 className="font-semibold">Stops</h2></div>
            <div className="relative mb-3"><Search className="w-4 h-4 absolute left-3 top-3 opacity-50" /><input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search stop name..." className={`${input} w-full rounded-2xl border pl-10 pr-3 py-2`} /></div>
            <div className="max-h-[28vh] overflow-auto space-y-2 pr-1">
              {filteredStops.map((stop) => (
                <button key={stop.stop_id} onClick={() => { setSelectedStop(stop); setSelectedRoute(null); }} className={`w-full text-left rounded-2xl p-3 border transition ${selectedStop?.stop_id === stop.stop_id ? "border-emerald-400 bg-emerald-500/10" : "border-white/10 hover:bg-white/5"}`}>
                  <div className="font-semibold">{stop.stop_name}</div>
                  <div className="text-xs opacity-70">{stop.stop_desc || stop.zone_id || "Stop"}</div>
                </button>
              ))}
            </div>
          </div>
        </div>

        <div className="col-span-12 lg:col-span-6">
          <div className={`${panel} rounded-3xl border p-2 shadow-xl h-[82vh] overflow-hidden`}>
            <MapContainer center={defaultCenter} zoom={11} style={{ height: "100%", width: "100%", borderRadius: "1.5rem" }}>
              <TileLayer attribution='&copy; OpenStreetMap contributors' url={dark ? "https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png" : "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"} />
              <fitBounds routeStops={selectedRouteStops} selectedStop={selectedStop} />
              {selectedRouteStops.length > 1 && <Polyline positions={selectedRouteStops.map((s) => [Number(s.stop_lat), Number(s.stop_lon)])} />}
              {showStops && (selectedRoute ? selectedRouteStops.slice(0, maxVisibleStops) : filteredStops.slice(0, 150)).map((stop) => (
                <Marker key={stop.stop_id} position={[Number(stop.stop_lat), Number(stop.stop_lon)]} icon={stopIcon} eventHandlers={{ click: () => setSelectedStop(stop) }}>
                  <Popup>
                    <div className="font-semibold">{stop.stop_name}</div>
                    <div className="text-xs">{stop.stop_desc || "Bus Stop"}</div>
                  </Popup>
                </Marker>
              ))}
            </MapContainer>
          </div>
        </div>

        <div className="col-span-12 lg:col-span-3 space-y-4">
          <div className={`${panel} rounded-3xl border p-4 shadow-xl`}>
            <div className="flex items-center gap-2 mb-3"><Layers className="w-4 h-4" /><h2 className="font-semibold">Map Controls</h2></div>
            <label className="flex items-center justify-between py-2"><span>Show stops</span><input type="checkbox" checked={showStops} onChange={(e) => setShowStops(e.target.checked)} /></label>
            <label className="block py-2">
              <div className="flex items-center justify-between mb-2"><span>Max visible route stops</span><span className="text-sm opacity-70">{maxVisibleStops}</span></div>
              <input type="range" min="50" max="500" step="25" value={maxVisibleStops} onChange={(e) => setMaxVisibleStops(Number(e.target.value))} className="w-full" />
            </label>
            <div className="text-sm opacity-70 mt-2">{loading ? "Loading GTFS feed…" : statusText}</div>
            <div className="text-xs opacity-60 mt-2">For public hosting, place your feed at <code>public/data/tgsrtc_gtfs.zip</code></div>
          </div>

          <div className={`${panel} rounded-3xl border p-4 shadow-xl min-h-[42vh]`}>
            <div className="flex items-center gap-2 mb-3"><Info className="w-4 h-4" /><h2 className="font-semibold">Details</h2></div>
            {!gtfs && <p className="text-sm opacity-70">The app will auto-load your GTFS feed when hosted with the ZIP in <code>public/data/tgsrtc_gtfs.zip</code>. Manual upload still works as fallback.</p>}
            {gtfs && selectedRoute && (
              <div className="space-y-3">
                <div>
                  <h3 className="text-xl font-bold">Route {selectedRoute.route_long_name || selectedRoute.route_id}</h3>
                  <p className="text-sm opacity-70">Trips: {selectedRoute.trip_count} • Stops in sample trip: {selectedRoute.stop_count}</p>
                </div>
                <div className="space-y-2 max-h-[48vh] overflow-auto pr-1">
                  {routeTripTimes.map((st, idx) => {
                    const stop = gtfs.stopsById[String(st.stop_id)];
                    if (!stop) return null;
                    return (
                      <button key={`${st.trip_id}-${st.stop_sequence}`} onClick={() => setSelectedStop(stop)} className={`w-full text-left rounded-2xl p-3 border ${routeStopIds.has(String(stop.stop_id)) ? "border-white/10" : "border-transparent"}`}>
                        <div className="flex items-center justify-between gap-3">
                          <div>
                            <div className="font-medium">{idx + 1}. {stop.stop_name}</div>
                            <div className="text-xs opacity-70">{stop.stop_desc || stop.zone_id || "Stop"}</div>
                          </div>
                          <div className="text-sm opacity-80">{formatClock(parseTimeToSeconds(st.departure_time))}</div>
                        </div>
                      </button>
                    );
                  })}
                </div>
              </div>
            )}
            {gtfs && selectedStop && !selectedRoute && (
              <div className="space-y-3">
                <h3 className="text-xl font-bold">{selectedStop.stop_name}</h3>
                <p className="text-sm opacity-70">{selectedStop.stop_desc || selectedStop.zone_id || "Bus Stop"}</p>
                <div className="text-sm">Lat/Lon: {Number(selectedStop.stop_lat).toFixed(5)}, {Number(selectedStop.stop_lon).toFixed(5)}</div>
                <div>
                  <div className="font-semibold mb-2">Routes serving this stop</div>
                  <div className="flex flex-wrap gap-2">
                    {[...(gtfs.stopRouteMap[String(selectedStop.stop_id)] || new Set())].slice(0, 60).map((rid) => (
                      <button key={rid} onClick={() => setSelectedRoute(gtfs.routes.find((r) => String(r.route_id) === rid))} className="px-3 py-1 rounded-full border border-white/10 text-sm hover:bg-white/5">{rid}</button>
                    ))}
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
