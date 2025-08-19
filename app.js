/*
	Food Roulette — Lafayette, IN
	- Fetches restaurants via Overpass API (OpenStreetMap)
	- Builds an interactive spinning wheel (SVG)
	- Lets users exclude cuisines; includes fast_food/cafe toggles
*/

// --- Constants
const LAFAYETTE_CENTER = { lat: 40.4167, lon: -86.8753 };
const LAFAYETTE_RADIUS_METERS = 9000; // Covers Lafayette & West Lafayette broadly
const OVERPASS_URLS = [
	"https://overpass-api.de/api/interpreter",
	"https://overpass.kumi.systems/api/interpreter",
	"https://overpass.openstreetmap.ru/api/interpreter"
];

// DOM refs
const statusMessage = document.getElementById("statusMessage");
const wheelGroup = document.getElementById("wheel");
const spinBtn = document.getElementById("spinBtn");
const resultCard = document.getElementById("resultCard");

const cuisineToggle = document.getElementById("cuisineToggle");
const cuisineMenu = document.getElementById("cuisineMenu");
const cuisineOptionsEl = document.getElementById("cuisineOptions");
const cuisineSearch = document.getElementById("cuisineSearch");
const selectNoneBtn = document.getElementById("selectNone");
const selectAllBtn = document.getElementById("selectAll");
const includeFastFood = document.getElementById("includeFastFood");
const includeCafe = document.getElementById("includeCafe");
const reloadBtn = document.getElementById("reloadBtn");

// State
let allPlaces = []; // [{id, name, cuisine[], tags, lat, lon, website, phone, street, city}]
let excludedCuisines = new Set();
let uniqueCuisines = [];
let currentFiltered = [];
let isSpinning = false;

// --- Utils
function dedupeById(items) {
	const seen = new Set();
	const out = [];
	for (const item of items) {
		if (!seen.has(item.id)) {
			seen.add(item.id);
			out.push(item);
		}
	}
	return out;
}

function extractCuisines(tags) {
	// OSM cuisine can be semicolon-delimited list
	const raw = tags.cuisine || "";
	return String(raw)
		.split(";")
		.map(x => x.trim().toLowerCase())
		.filter(Boolean);
}

function titleCase(str) {
	return str.replace(/\b([a-z])/g, (m, c) => c.toUpperCase());
}

function toPlace(obj) {
	const tags = obj.tags || {};
	const name = tags.name || "Unnamed";
	const cuisine = extractCuisines(tags);
	const website = tags.website || tags.url || "";
	const phone = tags.phone || tags["contact:phone"] || "";
	const street = tags["addr:street"] || "";
	const city = tags["addr:city"] || "";
	return {
		id: `${obj.type}/${obj.id}`,
		name,
		cuisine,
		tags,
		lat: obj.lat,
		lon: obj.lon,
		website,
		phone,
		street,
		city
	};
}

function buildOverpassQuery() {
	// Include nodes and ways tagged as restaurants; optionally fast_food and cafes controlled via checkboxes later
	// Fetch broad set then filter client-side to honor user toggles and cuisine exclusions
	return `[
		out:json][timeout:25];
	(
		node["amenity"~"restaurant|fast_food|cafe"](around:${LAFAYETTE_RADIUS_METERS},${LAFAYETTE_CENTER.lat},${LAFAYETTE_CENTER.lon});
		way["amenity"~"restaurant|fast_food|cafe"](around:${LAFAYETTE_RADIUS_METERS},${LAFAYETTE_CENTER.lat},${LAFAYETTE_CENTER.lon});
		relation["amenity"~"restaurant|fast_food|cafe"](around:${LAFAYETTE_RADIUS_METERS},${LAFAYETTE_CENTER.lat},${LAFAYETTE_CENTER.lon});
	);
	out center;`;
}

async function fetchPlaces() {
	statusMessage.textContent = "Fetching restaurants from OpenStreetMap…";
	const body = new URLSearchParams({ data: buildOverpassQuery() }).toString();
	const headers = { "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8" };
	let json = null;
	let lastErr = null;
	for (const url of OVERPASS_URLS) {
		try {
			const res = await fetch(url, { method: "POST", headers, body });
			if (!res.ok) throw new Error(`Overpass error: ${res.status} @ ${url}`);
			json = await res.json();
			break;
		} catch (e) {
			lastErr = e;
		}
	}
	if (!json) throw lastErr || new Error("Overpass failed");
	const elements = json.elements || [];
	const nodes = elements.map(el => {
		if (el.type === "node") return { ...el };
		const center = el.center || { lat: undefined, lon: undefined };
		return { id: el.id, type: el.type, lat: center.lat, lon: center.lon, tags: el.tags || {} };
	});
	const places = nodes
		.filter(n => n.tags && n.tags.amenity && ["restaurant","fast_food","cafe"].includes(n.tags.amenity))
		.map(toPlace);
	return dedupeById(places);
}

function updateCuisineOptions() {
	cuisineOptionsEl.innerHTML = "";
	for (const c of uniqueCuisines) {
		const id = `cuisine-${c.replace(/[^a-z0-9]+/g, "-")}`;
		const wrapper = document.createElement("label");
		wrapper.className = "dropdown-option";
		wrapper.innerHTML = `<input type="checkbox" data-cuisine="${c}" ${excludedCuisines.has(c) ? "checked" : ""}/> <span>${titleCase(c)}</span>`;
		cuisineOptionsEl.appendChild(wrapper);
	}
}

function collectUniqueCuisines() {
	const set = new Set();
	for (const p of allPlaces) {
		for (const c of p.cuisine) set.add(c);
	}
	uniqueCuisines = Array.from(set).sort((a, b) => a.localeCompare(b));
}

function applyFilters() {
	const allowed = new Set(uniqueCuisines.filter(c => !excludedCuisines.has(c)));
	currentFiltered = allPlaces.filter(p => {
		// Toggle filters for amenity subtype
		const amenity = p.tags.amenity;
		if (amenity === "fast_food" && !includeFastFood.checked) return false;
		if (amenity === "cafe" && !includeCafe.checked) return false;

		// Cuisine exclusion: if place has cuisines, require at least one allowed
		if (p.cuisine.length > 0) {
			return p.cuisine.some(c => allowed.has(c));
		}
		// If no cuisine listed, include by default
		return true;
	});
	buildWheel(currentFiltered);
	statusMessage.textContent = `${currentFiltered.length} places ready. Click SPIN!`;
	if (currentFiltered.length === 0) {
		statusMessage.textContent = `No places after filters. Adjust filters and reload.`;
	}
}

// --- Wheel rendering
const WHEEL_RADIUS = 500; // matches the viewBox scale roughly
function polarToCartesian(cx, cy, r, angleRadians) {
	return { x: cx + r * Math.cos(angleRadians), y: cy + r * Math.sin(angleRadians) };
}

function describeSlicePath(startAngle, endAngle) {
	const largeArc = endAngle - startAngle > Math.PI ? 1 : 0;
	const start = polarToCartesian(0, 0, WHEEL_RADIUS, startAngle);
	const end = polarToCartesian(0, 0, WHEEL_RADIUS, endAngle);
	return `M 0 0 L ${start.x} ${start.y} A ${WHEEL_RADIUS} ${WHEEL_RADIUS} 0 ${largeArc} 1 ${end.x} ${end.y} Z`;
}

function buildWheel(places) {
	while (wheelGroup.firstChild) wheelGroup.removeChild(wheelGroup.firstChild);
	if (!places || places.length === 0) return;

	const n = places.length;
	const anglePer = (Math.PI * 2) / n;

	for (let i = 0; i < n; i++) {
		const start = i * anglePer - Math.PI / 2; // Align first slice at top
		const end = start + anglePer;
		const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
		path.setAttribute("d", describeSlicePath(start, end));
		path.setAttribute("class", `slice-fill-${i % 8} slice-stroke`);
		wheelGroup.appendChild(path);

		// Label
		const mid = (start + end) / 2;
		const labelR = WHEEL_RADIUS * 0.65;
		const { x, y } = polarToCartesian(0, 0, labelR, mid);
		const text = document.createElementNS("http://www.w3.org/2000/svg", "text");
		text.setAttribute("x", String(x));
		text.setAttribute("y", String(y));
		text.setAttribute("class", "slice-text");
		const name = places[i].name.length > 28 ? places[i].name.slice(0, 27) + "…" : places[i].name;
		text.textContent = name;
		wheelGroup.appendChild(text);
	}
}

// --- Spin behavior
let accumulatedRotation = 0; // degrees

function spinWheel() {
	if (isSpinning) return;
	if (!currentFiltered || currentFiltered.length === 0) return;
	isSpinning = true;
	spinBtn.disabled = true;
	resultCard.classList.add("hidden");
	const n = currentFiltered.length;
	const sliceAngle = 360 / n;

	// Spin several turns plus a random fraction
	const extraSpins = 4 + Math.floor(Math.random() * 4); // 4..7
	const randomPart = Math.random() * 360; // 0..360
	const finalRotation = accumulatedRotation + extraSpins * 360 + randomPart;
	accumulatedRotation = finalRotation;

	wheelGroup.style.transition = "transform 5s cubic-bezier(0.12, 0.02, 0, 1)";
	wheelGroup.style.transform = `rotate(${finalRotation}deg)`;

	setTimeout(() => {
		isSpinning = false;
		spinBtn.disabled = false;
		// Determine winning index based on final rotation (pointer at -90°, slices start at -90°)
		const normalized = (((-finalRotation + 90) % 360) + 360) % 360; // 0..360
		const index = Math.floor(normalized / sliceAngle) % n;
		const chosen = currentFiltered[index];
		showResult(chosen);
	}, 5200);
}

function showResult(place) {
	const parts = [];
	if (place.street) parts.push(place.street);
	if (place.city) parts.push(place.city);
	const address = parts.join(", ");
	const cuisineStr = place.cuisine.length ? place.cuisine.map(titleCase).join(", ") : "Unspecified";
	const osmLink = `https://www.openstreetmap.org/${place.id}`;
	const mapLink = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(place.name + " " + (address || "Lafayette, IN"))}`;
	
	resultCard.innerHTML = `
		<div class="result-name">${place.name}</div>
		<div class="result-meta">Cuisine: ${cuisineStr}</div>
		${address ? `<div class="result-meta">Address: ${address}</div>` : ""}
		${place.phone ? `<div class="result-meta">Phone: ${place.phone}</div>` : ""}
		<div class="result-links">
			<a href="${mapLink}" target="_blank" rel="noopener">Open in Google Maps</a>
			<a href="${osmLink}" target="_blank" rel="noopener">OpenStreetMap</a>
			${place.website ? `<a href="${place.website}" target="_blank" rel="noopener">Website</a>` : ""}
		</div>
	`;
	resultCard.classList.remove("hidden");
}

// --- Dropdown interactions
cuisineToggle.addEventListener("click", () => {
	const expanded = cuisineMenu.getAttribute("aria-hidden") === "false";
	cuisineMenu.setAttribute("aria-hidden", expanded ? "true" : "false");
	cuisineToggle.setAttribute("aria-expanded", expanded ? "false" : "true");
});

document.addEventListener("click", (e) => {
	if (!cuisineMenu.contains(e.target) && !cuisineToggle.contains(e.target)) {
		cuisineMenu.setAttribute("aria-hidden", "true");
		cuisineToggle.setAttribute("aria-expanded", "false");
	}
});

cuisineSearch.addEventListener("input", () => {
	const q = cuisineSearch.value.trim().toLowerCase();
	for (const label of cuisineOptionsEl.querySelectorAll(".dropdown-option")) {
		const txt = label.textContent.trim().toLowerCase();
		label.style.display = txt.includes(q) ? "flex" : "none";
	}
});

selectNoneBtn.addEventListener("click", () => {
	excludedCuisines = new Set(); // clear exclusions
	updateCuisineOptions();
	applyFilters();
});

selectAllBtn.addEventListener("click", () => {
	excludedCuisines = new Set(uniqueCuisines); // exclude all
	updateCuisineOptions();
	applyFilters();
});

cuisineOptionsEl.addEventListener("change", (e) => {
	const target = e.target;
	if (target && target.matches("input[type=checkbox][data-cuisine]")) {
		const c = target.getAttribute("data-cuisine");
		if (target.checked) {
			excludedCuisines.add(c); // checked = excluded
		} else {
			excludedCuisines.delete(c);
		}
		applyFilters();
	}
});

includeFastFood.addEventListener("change", applyFilters);
includeCafe.addEventListener("change", applyFilters);
reloadBtn.addEventListener("click", async () => {
	await initialize();
});

spinBtn.addEventListener("click", spinWheel);

// --- Initialization
async function initialize() {
	try {
		spinBtn.disabled = true;
		statusMessage.textContent = "Loading data…";
		resultCard.classList.add("hidden");
		allPlaces = await fetchPlaces();
		collectUniqueCuisines();
		// Default: none excluded
		excludedCuisines = new Set();
		updateCuisineOptions();
		applyFilters();
		spinBtn.disabled = currentFiltered.length === 0;
	} catch (err) {
		console.error(err);
		statusMessage.textContent = "Failed to load data from Overpass. Please try Reload.";
	} finally {
		// no-op
	}
}

initialize();


