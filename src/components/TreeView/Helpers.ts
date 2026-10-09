export function formatRelativeTime(
	isoDate?: string,
): string {
	if (!isoDate) return '';
	const date = new Date(isoDate);
	if (isNaN(date.getTime())) return '';

	const now = Date.now();
	const diff = Math.abs(now - date.getTime());
	const hours = Math.floor(diff / (1000 * 60 * 60));
	const days = Math.floor(diff / (1000 * 60 * 60 * 24));

	if (hours < 24) {
		return date.toLocaleTimeString('en-US', {
			hour: '2-digit',
			minute: '2-digit',
			hour12: false,
		});
	}

	const month = date.toLocaleDateString('en-US', {
		month: 'short',
	});

	if (days < 365) {
		const day = date.toLocaleDateString('en-US', {
			day: '2-digit',
		});
		return `${day} ${month}`;
	}

	const year = date.toLocaleDateString('en-US', {
		year: 'numeric',
	});
	return `${month} ${year}`;
}

export function displayFileName(name: string): {
	stem: string;
	ext: string;
} {
	const lastDot = name.lastIndexOf('.');
	if (lastDot <= 0) return { stem: name, ext: '' };
	return {
		stem: name.slice(0, lastDot),
		ext: name.slice(lastDot),
	};
}

export function getDateKey(
	timestamp?: string,
): string {
	if (!timestamp) return '';
	const date = new Date(timestamp);
	if (isNaN(date.getTime())) return '';
	const year = date.getFullYear();
	const month = String(date.getMonth() + 1).padStart(
		2,
		'0',
	);
	const day = String(date.getDate()).padStart(2, '0');
	return `${year}-${month}-${day}`;
}

export function formatDateLabel(
	timestamp?: string,
): string {
	if (!timestamp) return '';
	const date = new Date(timestamp);
	if (isNaN(date.getTime())) return '';
	const now = new Date();
	const today = new Date(
		now.getFullYear(),
		now.getMonth(),
		now.getDate(),
	);
	const yesterday = new Date(
		today.getTime() - 24 * 60 * 60 * 1000,
	);
	const itemDate = new Date(
		date.getFullYear(),
		date.getMonth(),
		date.getDate(),
	);
	if (itemDate.getTime() === today.getTime())
		return 'Today';
	if (itemDate.getTime() === yesterday.getTime())
		return 'Yesterday';
	return date.toLocaleDateString('en-US', {
		weekday: 'short',
		month: 'short',
		day: 'numeric',
	});
}
