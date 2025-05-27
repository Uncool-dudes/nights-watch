# Night's watch
  ## Purpose
    The aim of this project is to provide analysis end points which can spawn 
    stockfish instances and parallelize the processing of chess moves.

  ## Endpoints

| Endpoints    	| Inputs                                           	| Return                                                                                                                                                            	|
|--------------	|--------------------------------------------------	|-------------------------------------------------------------------------------------------------------------------------------------------------------------------	|
| /eval        	| {<br>  fens: string[],<br>  depth?: number,<br>} 	| {<br>  move: string,<br>  bestMove: string,<br>  centipawn: number<br>}[]                                                                                         	|
| /healthcheck 	|                                                  	| {<br>  stockfish : {<br>                 installed: bool,<br>                 executable: bool,<br>                 performance: fishtest<br>              }<br>} 	|
