import { formatResult, runBench } from '../src/sim/bench';

runBench([256, 512], (r) => console.log(formatResult(r)));
