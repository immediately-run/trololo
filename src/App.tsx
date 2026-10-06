// Root component — immediately.run renders the default export of THIS file.
// Global CSS is imported here (not in main.tsx) because immediately.run's
// runtime never loads main.tsx; anything the rendered tree needs must be
// reachable from App.tsx.
import './index.css';
import './App.css';
import Nav from './components/Nav';
import Footer from './components/Footer';

function App() {
  return (
    <>
      <Nav />
      <main className="wrap">
        <section className="hero">
          <h1>
            Boards that merge <span className="grad-text">correctly.</span>
          </h1>
          <p className="deck">
            Trololo is a Trello-like board where several people edit live and git stays the truth at
            rest. This build carries the collaboration-session engine and its test harness; the board
            itself arrives next.
          </p>
        </section>
        <Footer />
      </main>
    </>
  );
}

export default App;
