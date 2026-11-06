# Console appearance

The visual system is defined in `workers/console/public/console.css`. This is a product interface: retain the existing layout, system font stack, 14px body text, compact controls, tables and 8px surface radii.

## Color and themes

Use restrained blue-tinted neutrals with blue primary actions. Dark mode retains the upstream charcoal palette; light mode uses near-white page and panel surfaces, dark slate text, and darker semantic greens, ambers and reds for readable status labels. New light tokens use OKLCH. Use semantic CSS variables in HTML, inline styles and SVG charts rather than hardcoded dark colors.

## Preference

The native Theme selector offers System, Light and Dark. System is the default. Apply the effective theme synchronously in the document head, before styles paint. Save only the preference in `localStorage`; listen for system changes and cross-tab storage events. Keep an in-memory preference when storage is blocked.

## Components and branding

Place the selector beside existing header controls, beside the login language selector, and within the homepage content. Let header controls wrap on small screens. Keep focus rings visible. Switch between light-ink and dark-ink brand logos with the effective theme, retaining the available logo as a fallback. Charts inherit palette variables without refetching data.
