import "./styles.css";
import "./cinematic-motion.css";
import { createRevealController } from "./motion/reveal-controller";

const revealController = createRevealController();
revealController.start();

if (import.meta.hot) {
  import.meta.hot.dispose(() => revealController.destroy());
}
