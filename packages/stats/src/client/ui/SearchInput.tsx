import { Search } from "lucide-react";

export interface SearchInputProps {
	value: string;
	onChange: (value: string) => void;
	placeholder?: string;
	label?: string;
	width?: number;
}

/** Text filter with a leading search glyph. */
export function SearchInput({ value, onChange, placeholder = "Filter…", label = "Filter", width }: SearchInputProps) {
	return (
		<label className="search">
			<Search size={14} />
			<input
				className="input"
				type="search"
				aria-label={label}
				value={value}
				placeholder={placeholder}
				onChange={e => onChange(e.target.value)}
				style={width !== undefined ? { width } : undefined}
			/>
		</label>
	);
}
