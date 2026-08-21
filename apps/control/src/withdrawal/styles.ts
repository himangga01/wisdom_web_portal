export const WITHDRAWAL_STYLES_PATH = "/marketing/withdraw/styles.css";

export const WITHDRAWAL_STYLES = `:root {
  color-scheme: light;
  font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  background: #f4f7fb;
  color: #172033;
}

* {
  box-sizing: border-box;
}

body {
  min-height: 100vh;
  margin: 0;
  display: grid;
  place-items: center;
  padding: 2rem 1rem;
  background: #f4f7fb;
}

.withdrawal-card {
  width: min(100%, 42rem);
  padding: clamp(1.5rem, 5vw, 3rem);
  border: 1px solid #d7dfeb;
  border-radius: 1rem;
  background: #ffffff;
  box-shadow: 0 1rem 2.5rem rgb(23 32 51 / 10%);
}

h1 {
  margin: 0;
  color: #172033;
  font-size: clamp(1.65rem, 4vw, 2.25rem);
  line-height: 1.25;
}

p {
  margin: 1rem 0 0;
  color: #45516a;
  font-size: 1rem;
  line-height: 1.7;
}

form {
  margin-top: 2rem;
}

button {
  min-height: 2.75rem;
  width: 100%;
  border: 0;
  border-radius: 0.65rem;
  padding: 0.75rem 1.25rem;
  background: #173f75;
  color: #ffffff;
  font: inherit;
  font-weight: 700;
  cursor: pointer;
}

button:hover {
  background: #0f315e;
}

button:focus-visible,
a:focus-visible {
  outline: 3px solid #f0a300;
  outline-offset: 3px;
}

.withdrawal-card--success h1 {
  color: #17603a;
}

.withdrawal-card--error h1 {
  color: #9f2d25;
}

@media (max-width: 30rem) {
  body {
    padding: 1rem;
  }

  .withdrawal-card {
    border-radius: 0.75rem;
  }
}
`;
